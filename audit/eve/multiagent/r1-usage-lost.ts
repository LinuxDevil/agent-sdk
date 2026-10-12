/* Eve multiagent repro 1: delegated usage that never reaches the lead's totals.
 *  A) a sub-agent that spends tokens and then fails (provider error) - its spend vanishes.
 *  B) a background sub-agent awaited by awaitBackgroundOnFinish - lead's result.usage vs run.done.
 *  C) a background sub-agent cancelled at run end after spending tokens.
 * Deterministic (mockModel), no network. Run: npx tsx eve/multiagent/r1-usage-lost.ts
 */
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';

const noop = defineTool({ name: 'noop', description: 'does nothing', input: z.object({}), execute: async () => 'ok' });
const u = (i: number, o: number) => ({ inputTokens: i, outputTokens: o });

async function scenarioA() {
  const child = mockModel(
    [
      { toolCalls: [{ name: 'noop' }], usage: u(1000, 100) },
      { error: Object.assign(new Error('400 Bad Request: context too long'), { status: 400 }) },
    ],
    { onExhausted: 'repeat-last' }
  );
  const lead = mockModel([
    { toolCalls: [{ name: 'task', args: { agent: 'worker', prompt: 'do it', description: 'do it' } }], usage: u(10, 1) },
    { text: 'final', usage: u(10, 1) },
  ]);
  const worker = createAgent({ provider: child, instructions: 'w', description: 'Worker', tools: [noop], retry: false } as any);
  const agent = createAgent({ provider: lead, instructions: 'lead', subagents: { worker } });
  const r = await agent.send('go');
  const toolMsg = r.messages.find((m: any) => m.role === 'tool');
  console.log('[A] child model calls:', child.calls.length, '(first spent 1000 in / 100 out)');
  console.log('[A] lead tool result:', JSON.stringify(toolMsg?.content).slice(0, 160));
  console.log('[A] lead usage totals:', r.usage.inputTokens, '/', r.usage.outputTokens, 'delegated:', JSON.stringify(r.usage.delegated));
  console.log(r.usage.inputTokens >= 1020 ? '[A] OK' : '[A] BUG: the failed child\'s 1000 input tokens are missing from result.usage');
}

async function scenarioB() {
  const child = mockModel([{ text: 'bg answer', usage: u(500, 50), delayMs: 300 }]);
  const lead = mockModel([
    { toolCalls: [{ name: 'task', args: { agent: 'worker', prompt: 'p', description: 'bg', background: true } }], usage: u(10, 1) },
    { text: 'lead done', usage: u(10, 1) },
  ]);
  const worker = createAgent({ provider: child, instructions: 'w', description: 'Worker' });
  let doneUsage: any;
  const agent = createAgent({
    provider: lead,
    instructions: 'lead',
    subagents: { worker },
    subagentOptions: { awaitBackgroundOnFinish: true },
    onEvent: (e: any) => {
      if (e.type === 'run.done' && !e.subagent) doneUsage = e.usage ?? e.result?.usage;
    },
  } as any);
  const r = await agent.send('go');
  await new Promise((res) => setTimeout(res, 50));
  console.log('[B] backgroundTasks:', JSON.stringify(r.backgroundTasks?.map((t: any) => [t.taskId, t.status])));
  console.log('[B] result.usage input:', r.usage.inputTokens, 'delegated:', JSON.stringify(r.usage.delegated));
  console.log('[B] run.done usage input:', doneUsage?.inputTokens);
  console.log('[B] lousho formatted? costUsd', r.usage.costUsd);
}

async function scenarioC() {
  const child = mockModel(
    [
      { toolCalls: [{ name: 'noop' }], usage: u(700, 70) },
      { text: 'never', usage: u(1, 1), delayMs: 2000 },
    ]
  );
  const lead = mockModel([
    { toolCalls: [{ name: 'task', args: { agent: 'worker', prompt: 'p', description: 'bg', background: true } }], usage: u(10, 1) },
    { text: 'lead done', usage: u(10, 1), delayMs: 200 },
  ]);
  const worker = createAgent({ provider: child, instructions: 'w', description: 'Worker', tools: [noop] });
  const agent = createAgent({ provider: lead, instructions: 'lead', subagents: { worker } });
  const r = await agent.send('go');
  console.log('[C] backgroundTasks:', JSON.stringify(r.backgroundTasks?.map((t: any) => [t.taskId, t.status])));
  console.log('[C] child calls made:', child.calls.length, '-> result.usage input:', r.usage.inputTokens, 'delegated:', JSON.stringify(r.usage.delegated));
  console.log(r.usage.inputTokens >= 720 ? '[C] OK' : '[C] BUG: cancelled background child spent 700 input tokens that result.usage never shows');
}

await scenarioA().catch((e) => console.log('[A] threw', e.code, e.message));
await scenarioB().catch((e) => console.log('[B] threw', e.code, e.message));
await scenarioC().catch((e) => console.log('[C] threw', e.code, e.message));
