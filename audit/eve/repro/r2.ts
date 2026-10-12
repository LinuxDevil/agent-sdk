/* Eve repro 2: concurrency, forced-answer events/stepUsage, limits.maxSteps interplay */
import { createAgent } from '../../../src/createAgent';
import { mockModel } from '../../../src/testing/mockModel';
import { memoryStore } from '../../../src/storage/agentStore';
import { z } from 'zod';
import { defineTool } from '../../../src/tools/defineTool';

async function t(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    console.log(`${name}: THREW`, e instanceof Error ? `${e.name}: ${e.message}` : e);
  }
}

// A. Two concurrent send() with the same sessionId on a durable agent
await t('concurrent-same-sessionId', async () => {
  const model = mockModel(['one', 'two'], { onExhausted: 'repeat-last' });
  const agent = createAgent({ provider: model, store: memoryStore() });
  const [a, b] = await Promise.all([
    agent.send('first', { sessionId: 'job-1' }),
    agent.send('second', { sessionId: 'job-1' }),
  ]);
  console.log('a:', a.finishReason, JSON.stringify(a.text), 'msgs:', a.messages.length);
  console.log('b:', b.finishReason, JSON.stringify(b.text), 'msgs:', b.messages.length);
  console.log('model calls:', model.calls.length);
});

// B. step events + stepUsage for the forced no-tools answer
await t('forced-answer-events', async () => {
  const model = mockModel([
    { toolCalls: [{ name: 'noop', args: {} }] },
    { toolCalls: [{ name: 'noop', args: {} }] },
    '{"city":"Paris"}',
  ]);
  const noop = defineTool({ name: 'noop', description: 'n', input: z.object({}), execute: async () => 'ok' });
  const agent = createAgent({ provider: model, tools: [noop], maxSteps: 2, output: z.object({ city: z.string() }) });
  const events: string[] = [];
  const run = agent.stream('weather?');
  for await (const ev of run) events.push(ev.type + (ev.type.startsWith('step.') ? `:${(ev as { step?: number }).step}` : ''));
  const r = await run.result;
  console.log('events:', events.join(' '));
  console.log('result.steps:', r.steps, 'stepUsage:', JSON.stringify(r.stepUsage?.map((s) => s.step)));
});

// C. maxSteps option vs limits.maxSteps — docs: "the stricter wins (the option's tie reports 'max-steps')"
await t('maxSteps-vs-limits', async () => {
  // limits stricter than option
  const m1 = mockModel([{ toolCalls: [{ name: 'noop' }] }, 'done'], { onExhausted: 'repeat-last' });
  const noop = defineTool({ name: 'noop', description: 'n', input: z.object({}), execute: async () => 'ok' });
  const a1 = createAgent({ provider: m1, tools: [noop], maxSteps: 5, limits: { maxSteps: 2 } });
  const r1 = await a1.send('go');
  console.log('maxSteps=5 limits.maxSteps=2 ->', r1.finishReason, 'steps:', r1.steps, 'budget:', JSON.stringify(r1.budget));

  // option stricter than limits
  const m2 = mockModel([{ toolCalls: [{ name: 'noop' }] }, 'done'], { onExhausted: 'repeat-last' });
  const a2 = createAgent({ provider: m2, tools: [noop], maxSteps: 2, limits: { maxSteps: 5 } });
  const r2 = await a2.send('go');
  console.log('maxSteps=2 limits.maxSteps=5 ->', r2.finishReason, 'steps:', r2.steps);

  // tie
  const m3 = mockModel([{ toolCalls: [{ name: 'noop' }] }, 'done'], { onExhausted: 'repeat-last' });
  const a3 = createAgent({ provider: m3, tools: [noop], maxSteps: 2, limits: { maxSteps: 2 } });
  const r3 = await a3.send('go');
  console.log('maxSteps=2 limits.maxSteps=2 ->', r3.finishReason, 'steps:', r3.steps);
});

// D. stream() never iterated — does result still resolve?
await t('stream-not-iterated', async () => {
  const model = mockModel(['hi']);
  const agent = createAgent({ provider: model });
  const run = agent.stream('hello');
  const r = await run.result;
  console.log('stream-not-iterated ->', r.finishReason, JSON.stringify(r.text));
});

// E. double iteration of AgentRun
await t('stream-double-iterate', async () => {
  const model = mockModel(['hi']);
  const agent = createAgent({ provider: model });
  const run = agent.stream('hello');
  for await (const _ of run) { /* drain */ }
  try {
    for await (const _ of run) { /* second */ }
    console.log('second iteration silently ok');
  } catch (e) {
    console.log('second iteration threw:', (e as Error).message);
  }
});

// F. reasoning option reaches provider request even for models that cannot reason?
await t('reasoning-passthrough', async () => {
  const model = mockModel(['hi']);
  const agent = createAgent({ provider: model, reasoning: 'bogus-value' as never });
  await agent.send('hi');
  console.log('request.reasoning:', JSON.stringify(model.lastCall?.reasoning));
});

// G. send() after send() with sessionId — messages cumulative?
await t('sessionId-continue', async () => {
  const model = mockModel(['one', 'two']);
  const agent = createAgent({ provider: model, store: memoryStore() });
  await agent.send('first', { sessionId: 'j1' });
  const r = await agent.send('second', { sessionId: 'j1' });
  console.log('second-call request msgs:', model.lastCall?.messages.map((m) => `${m.role}`).join(','));
  console.log('result.messages count:', r.messages.length);
});

// H. abort mid-run resolves 'aborted'
await t('abort', async () => {
  const model = mockModel([{ toolCalls: [{ name: 'slow' }] }, 'done'], { onExhausted: 'repeat-last' });
  const slow = defineTool({
    name: 'slow',
    description: 'n',
    input: z.object({}),
    execute: async (_a, ctx) => {
      await new Promise((r) => setTimeout(r, 5000));
      return 'ok';
    },
  });
  const agent = createAgent({ provider: model, tools: [slow] });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  const r = await agent.send('go', { signal: ac.signal });
  console.log('abort ->', r.finishReason, 'msgs:', r.messages.map((m) => m.role).join(','));
});
