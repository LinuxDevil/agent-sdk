// CORE: streaming errors, abort latency, timeouts (deterministic).
// Run: npx tsx eve/core/r4-stream-abort-errors.ts
import { z } from 'zod';
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const authErr = Object.assign(new Error('Incorrect API key provided'), { statusCode: 401 });

// A: provider failure while iterating stream(): does the for-await throw?
{
  const agent = createAgent({ provider: mockModel([{ error: authErr }]), retry: false });
  const run = agent.stream('hi');
  const types: string[] = [];
  let threw: unknown;
  try {
    for await (const e of run) types.push(e.type === 'run.done' ? `run.done(${e.finishReason})` : e.type);
  } catch (e) {
    threw = e;
  }
  let resultErr: any;
  await run.result.catch((e) => (resultErr = e));
  console.log('A loop threw=%s events=%j result rejects with %s/%s', Boolean(threw), types, resultErr?.name, resultErr?.code);
}

// B: abort latency with a tool that ignores ctx.signal
{
  const slow = defineTool({
    name: 'slow',
    description: 'slow',
    input: z.object({}),
    execute: async () => {
      await new Promise((r) => setTimeout(r, 3000));
      return 'ok';
    },
  });
  const agent = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'slow' }] }, 'done']), tools: [slow] });
  const t0 = Date.now();
  const r = await agent.send('go', { signal: AbortSignal.timeout(100) });
  console.log('B abort@100ms with non-cooperative tool: resolved after %dms finishReason=%s', Date.now() - t0, r.finishReason);
}

// C: abort while a (non-signal-aware) provider call hangs
{
  const hang = mockModel([{ text: 'late', delayMs: 3000 }]);
  const agent = createAgent({ provider: hang });
  const t0 = Date.now();
  const r = await agent.send('go', { signal: AbortSignal.timeout(100) });
  console.log('C abort@100ms during model call: resolved after %dms finishReason=%s text=%j', Date.now() - t0, r.finishReason, r.text);
}

// D: already-aborted signal - does any model call happen?
{
  const m = mockModel(['should not run'], { onExhausted: 'repeat-last' });
  const agent = createAgent({ provider: m });
  const ac = new AbortController();
  ac.abort();
  const r = await agent.send('go', { signal: ac.signal });
  console.log('D pre-aborted: finishReason=%s modelCalls=%d', r.finishReason, m.calls.length);
}

// E: abort reason is lost? (timeout vs user cancel indistinguishable)
{
  const agent = createAgent({ provider: mockModel([{ text: 'x', delayMs: 500 }]) });
  const r: any = await agent.send('go', { signal: AbortSignal.timeout(50) });
  console.log('E result keys on abort: %j', Object.keys(r));
}

// F: a non-retryable 400 from the provider - error class and message
{
  const bad = Object.assign(new Error("Invalid value for 'temperature': 5 > 2"), { statusCode: 400, responseBody: '{"error":{"message":"temperature too high"}}' });
  const agent = createAgent({ provider: mockModel([{ error: bad }]) });
  try {
    await agent.send('x');
  } catch (e: any) {
    console.log('F send rejects: name=%s code=%s instanceof Error=%s msg=%j', e.name, e.code, e instanceof Error, String(e.message).slice(0, 200));
  }
}
