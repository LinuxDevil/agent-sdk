/* Eve repro 3 */
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

const noop = defineTool({ name: 'noop', description: 'n', input: z.object({}), execute: async () => 'ok' });
const loopForever = () => mockModel([{ toolCalls: [{ name: 'noop' }] }], { onExhausted: 'repeat-last' });

// A. maxSteps option vs limits.maxSteps — model loops forever
await t('limits-stricter', async () => {
  const agent = createAgent({ provider: loopForever(), tools: [noop], maxSteps: 5, limits: { maxSteps: 2 } });
  const r = await agent.send('go');
  console.log('maxSteps=5 limits=2 ->', r.finishReason, 'steps:', r.steps, 'budget:', JSON.stringify(r.budget));
});
await t('option-stricter', async () => {
  const agent = createAgent({ provider: loopForever(), tools: [noop], maxSteps: 2, limits: { maxSteps: 5 } });
  const r = await agent.send('go');
  console.log('maxSteps=2 limits=5 ->', r.finishReason, 'steps:', r.steps, 'budget:', JSON.stringify(r.budget));
});
await t('tie', async () => {
  const agent = createAgent({ provider: loopForever(), tools: [noop], maxSteps: 2, limits: { maxSteps: 2 } });
  const r = await agent.send('go');
  console.log('maxSteps=2 limits=2 ->', r.finishReason, 'steps:', r.steps);
});
// limits.maxSteps alone replaces default 10?
await t('limits-only', async () => {
  const agent = createAgent({ provider: loopForever(), tools: [noop], limits: { maxSteps: 3 } });
  const r = await agent.send('go');
  console.log('limits.maxSteps=3 only ->', r.finishReason, 'steps:', r.steps);
});

// B. approve callback throws — what happens to the run?
await t('approve-throws', async () => {
  const model = mockModel([{ toolCalls: [{ name: 'danger' }] }, 'done']);
  const danger = defineTool({ name: 'danger', description: 'n', input: z.object({}), execute: async () => 'ok', needsApproval: true });
  const agent = createAgent({ provider: model, tools: [danger], approve: () => { throw new Error('policy engine down'); } });
  try {
    const r = await agent.send('do it');
    console.log('approve-throws ->', r.finishReason);
  } catch (e) {
    console.log('approve-throws -> REJECTED:', (e as Error).name, (e as Error).message);
  }
});

// C. session transcript retains the 'out of steps' + '[output-invalid]' fake user messages into NEXT turn
await t('session-leaked-messages', async () => {
  const model = mockModel([
    { toolCalls: [{ name: 'noop' }] },
    { toolCalls: [{ name: 'noop' }] },
    '{"city":"Paris"}',
    '{"city":"London"}',
  ]);
  const agent = createAgent({ provider: model, tools: [noop], maxSteps: 2, output: z.object({ city: z.string() }) });
  const session = agent.session();
  await session.send('weather in Paris?');
  await session.send('and London?');
  const req = model.lastCall!.messages;
  console.log('next-turn request roles:', req.map((m) => m.role).join(','));
  console.log('user msgs seen by model:', req.filter((m) => m.role === 'user').map((m) => JSON.stringify(String(m.content).slice(0, 80))));
});

// D. send() options validation gaps
await t('approvalTtlMs-negative-on-send', async () => {
  const model = mockModel(['ok']);
  const agent = createAgent({ provider: model });
  const r = await agent.send('hi', { approvalTtlMs: -5 });
  console.log('approvalTtlMs=-5 ->', r.finishReason);
});
await t('send-no-args', async () => {
  const model = mockModel(['ok']);
  const agent = createAgent({ provider: model });
  // @ts-expect-error probe
  await agent.send();
});
await t('send-null', async () => {
  const model = mockModel(['ok']);
  const agent = createAgent({ provider: model });
  // @ts-expect-error probe
  await agent.send(null);
});

// E. fallbackModels resolved eagerly at createAgent()? (no ANTHROPIC_API_KEY in env)
await t('fallback-eager-key', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test';
  createAgent({ model: 'openai/gpt-4o-mini', fallbackModels: ['anthropic/claude-3-5-haiku-latest'] });
  console.log('fallback-eager-key -> agent created WITHOUT anthropic key');
});

// F. send() with bad model spec suggestions
await t('bad-spec', async () => {
  createAgent({ model: 'opnai/gpt-4o' });
});
await t('no-slash-spec', async () => {
  createAgent({ model: 'gpt-4o' });
});

// G. modelSettings passthrough of garbage
await t('modelSettings-garbage', async () => {
  const model = mockModel(['ok']);
  const agent = createAgent({ provider: model, modelSettings: { temperature: 'hot' } as never });
  await agent.send('hi');
  console.log('sent temperature:', JSON.stringify(model.lastCall?.temperature));
});
