// Runtime checks for docs/streaming.md claims using mockModel.
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { AgentExecutor } from '@lousho/build-ai-agent/executor';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';

const log = (l: string, v: unknown) => console.log(`[${l}]`, typeof v === 'string' ? v : JSON.stringify(v));

process.on('unhandledRejection', (e) => log('UNHANDLED REJECTION', String(e)));

// 1. starts immediately, result without iteration
{
  const agent = createAgent({ provider: mockModel(['hello there world']) });
  const run = agent.stream('hi');
  const r = await run.result;
  log('1 result-no-iter', { fr: r.finishReason, text: r.text });
  // iterate after finished: all events?
  const types: string[] = [];
  for await (const e of run) types.push(e.type);
  log('1 iterate-after-finish', types);
  // second iteration
  try {
    for await (const _ of run) { /* */ }
    log('1 second-iter', 'no throw');
  } catch (e) {
    log('1 second-iter throws', String(e));
  }
}

// 2. break early -> aborted, step.done aborted + run.done aborted
{
  const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
  const agent = createAgent({ provider: mockModel([{ text: long, delayMs: 0 }]) });
  const run = agent.stream('story');
  let n = 0;
  for await (const e of run) {
    if (e.type === 'text.delta') n++;
    if (n > 5) break;
  }
  const r = await run.result;
  log('2 break -> finishReason', r.finishReason);
}

// 2b. signal abort: event tail
{
  const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
  const agent = createAgent({ provider: mockModel([{ text: long }]) });
  const ac = new AbortController();
  const run = agent.stream('story', { signal: ac.signal });
  const types: string[] = [];
  let n = 0;
  for await (const e of run) {
    types.push(e.type + (('finishReason' in e) ? `(${(e as any).finishReason})` : ''));
    if (e.type === 'text.delta' && ++n === 3) ac.abort();
  }
  log('2b signal tail', types.slice(-4));
  log('2b result', (await run.result).finishReason);
}

// 3. invalid options throw synchronously from stream()
{
  try {
    const r = AgentExecutor.stream({ agent: { id: 'a', name: 'a', prompt: 'x' } as any, input: 'hi' } as any);
    log('3 no provider', 'did NOT throw sync; result=' + (await r.result.then(() => 'resolved', (e) => 'rejected ' + e?.message)));
  } catch (e: any) {
    log('3 no provider throws sync', e.message);
  }
  try {
    const r = AgentExecutor.stream({ agent: { id: 'a', name: 'a', prompt: 'x' } as any, input: 'hi', provider: mockModel(['x']), toolConcurrency: -3 } as any);
    log('3 bad toolConcurrency', 'did NOT throw sync; ' + (await r.result.then(() => 'resolved', (e) => 'rejected ' + e?.message)));
  } catch (e: any) {
    log('3 bad toolConcurrency throws sync', e.message);
  }
}

// 4. result unawaited, failing run -> no unhandled rejection
{
  const agent = createAgent({ provider: mockModel([{ error: new Error('upstream 503') }]) });
  const run = agent.stream('hi');
  const types: string[] = [];
  try { for await (const e of run) types.push(e.type); } catch (e: any) { types.push('THROW:' + e.message); }
  log('4 error stream events', types);
  await new Promise((r) => setTimeout(r, 50));
}

// 5. listener + send: multiple text.delta per step; event envelope fields
{
  const events: any[] = [];
  const agent = createAgent({ provider: mockModel(['one two three four']), onEvent: (e) => events.push(e) });
  await agent.send('hi');
  log('5 onEvent+send types', events.map((e) => e.type));
  const e0 = events[0];
  log('5 envelope', { type: e0.type, runId: !!e0.runId, seq: e0.seq, ts: e0.timestamp, v: e0.v });
  const done = events.find((e) => e.type === 'run.done');
  log('5 run.done', { fr: done.finishReason, usage: done.usage, text: done.text });
}

// 6. terminal example with tool
{
  const getWeather = defineTool({
    name: 'get_weather', description: 'x', input: z.object({ city: z.string() }),
    execute: async ({ city }) => ({ city, tempC: 21 }),
  });
  const agent = createAgent({
    provider: mockModel([{ toolCalls: [{ name: 'get_weather', args: { city: 'Paris' } }] }, 'It is 21C']),
    tools: [getWeather],
  });
  const seq: string[] = [];
  for await (const e of agent.stream('Weather?')) {
    if (e.type === 'tool.start') seq.push(`tool.start ${e.toolName} ${JSON.stringify(e.args)}`);
    else if (e.type === 'tool.done') seq.push(`tool.done ${e.toolName} ${e.durationMs}`);
    else if (e.type === 'run.done') seq.push(`run.done ${e.finishReason} ${e.usage?.totalTokens}`);
    else seq.push(e.type);
  }
  log('6 terminal', seq);
}

// 7. session stream: second turn sees first; aborted not saved
{
  const model = mockModel(['Nice to meet you Ali', 'Your name is Ali', Array.from({ length: 200 }, (_, i) => `w${i}`).join(' '), 'after']);
  const agent = createAgent({ provider: model });
  const session = agent.session({ id: 'user-42' });
  let lastType = '';
  for await (const e of session.stream('My name is Ali.')) lastType = e.type;
  const again = session.stream('What is my name?');
  await again.result;
  log('7 turn2 msgs', model.calls[1].messages.map((m: any) => `${m.role}:${String(m.content).slice(0, 20)}`));
  // abort third via break
  const third = session.stream('long');
  let k = 0;
  for await (const e of third) { if (e.type === 'text.delta' && ++k > 2) break; }
  log('7 third fr', (await third.result).finishReason);
  await session.stream('after?').result;
  log('7 turn4 msgs', model.calls[3].messages.map((m: any) => `${m.role}:${String(m.content).slice(0, 20)}`));
}
