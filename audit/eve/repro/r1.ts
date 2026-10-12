/* Eve repro: core-loop edge cases with mockModel */
import { createAgent } from '../../../src/createAgent';
import { mockModel } from '../../../src/testing/mockModel';
import { z } from 'zod';

async function t(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    console.log(`${name}: THREW`, e instanceof Error ? `${e.name}: ${e.message}` : e);
  }
}

// 1. maxSteps validation
await t('maxSteps=0', async () => {
  const model = mockModel(['hi']);
  const agent = createAgent({ provider: model, maxSteps: 0 });
  const r = await agent.send('hello');
  console.log('maxSteps=0 ->', r.finishReason, 'steps:', r.steps, 'text:', JSON.stringify(r.text), 'calls:', model.calls.length);
});
await t('maxSteps=-3', async () => {
  const model = mockModel(['hi']);
  const agent = createAgent({ provider: model, maxSteps: -3 });
  const r = await agent.send('hello');
  console.log('maxSteps=-3 ->', r.finishReason, 'steps:', r.steps, 'calls:', model.calls.length);
});
await t('maxSteps=1.5', async () => {
  const model = mockModel(['a', 'b']);
  const agent = createAgent({ provider: model, maxSteps: 1.5 });
  const r = await agent.send('hello');
  console.log('maxSteps=1.5 ->', r.finishReason, 'steps:', r.steps, 'calls:', model.calls.length);
});
await t('limits.maxTokens=-1', async () => {
  const model = mockModel(['hi']);
  const agent = createAgent({ provider: model, limits: { maxTokens: -1 } });
  const r = await agent.send('hello');
  console.log('maxTokens=-1 ->', r.finishReason, 'calls:', model.calls.length, 'budget:', JSON.stringify(r.budget));
});

// 2. provider instance + spec-style model string
await t('provider+specmodel', async () => {
  const model = mockModel(['ok']);
  const agent = createAgent({ provider: model, model: 'openai/gpt-4o' });
  await agent.send('hi');
  console.log('request.model sent to provider:', JSON.stringify(model.lastCall?.model));
});

// 3. onEvent listener throws
await t('onEvent-throws', async () => {
  const model = mockModel(['hi']);
  const agent = createAgent({ provider: model, onEvent: () => { throw new Error('UI listener broke'); } });
  try {
    const r = await agent.send('hello');
    console.log('onEvent-throws -> resolved', r.finishReason);
  } catch (e) {
    console.log('onEvent-throws -> REJECTED:', (e as Error).message);
  }
});

// 4. forcedAnswer 'You are out of steps' in result.messages + session transcript
await t('out-of-steps-injection', async () => {
  const model = mockModel([
    { toolCalls: [{ name: 'noop', args: {} }] },
    { toolCalls: [{ name: 'noop', args: {} }] },
    '{"city":"Paris","tempC":21}',
  ]);
  const { defineTool } = await import('../../../src/tools/defineTool');
  const noop = defineTool({ name: 'noop', description: 'n', input: z.object({}), execute: async () => 'ok' });
  const agent = createAgent({ provider: model, tools: [noop], maxSteps: 2, output: z.object({ city: z.string(), tempC: z.number() }) });
  const r = await agent.send('weather?');
  console.log('finishReason:', r.finishReason, 'object:', JSON.stringify(r.object), 'calls:', model.calls.length);
  console.log('roles:', r.messages.map((m) => m.role).join(','));
  const injected = r.messages.filter((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('out of steps'));
  console.log('injected user msgs:', injected.length, JSON.stringify(injected[0]?.content).slice(0, 120));
});

// 5. output repair message persists in messages
await t('repair-msg-persists', async () => {
  const model = mockModel(['not json', '{"city":"Paris","tempC":21}']);
  const agent = createAgent({ provider: model, output: z.object({ city: z.string(), tempC: z.number() }) });
  const r = await agent.send('weather?');
  console.log('finishReason:', r.finishReason, 'repaired:', r.outputRepaired);
  console.log('user msgs:', r.messages.filter((m) => m.role === 'user').map((m) => JSON.stringify(String(m.content).slice(0, 60))));
});

// 6. empty / weird inputs
await t('send-empty-string', async () => {
  const model = mockModel(['ok']);
  const agent = createAgent({ provider: model });
  const r = await agent.send('');
  console.log('send("") ->', r.finishReason, 'msgs:', model.lastCall?.messages.map((m) => m.role).join(','));
});
await t('send-empty-array', async () => {
  const model = mockModel(['ok']);
  const agent = createAgent({ provider: model });
  const r = await agent.send([]);
  console.log('send([]) ->', r.finishReason, 'msgs:', model.lastCall?.messages.map((m) => m.role).join(','));
});
await t('send-number', async () => {
  const model = mockModel(['ok']);
  const agent = createAgent({ provider: model });
  // @ts-expect-error runtime probe
  const r = await agent.send(42);
  console.log('send(42) ->', r.finishReason, 'last user msg:', JSON.stringify(model.lastCall?.messages.at(-1)));
});

// 7. user-supplied Message[] with system + assistant roles
await t('send-Message[]-with-system', async () => {
  const model = mockModel(['ok']);
  const agent = createAgent({ provider: model, instructions: 'BE AN AGENT.' });
  const r = await agent.send([
    { role: 'system', content: 'USER SYSTEM' },
    { role: 'user', content: 'hi' },
  ]);
  const sent = model.lastCall!.messages;
  console.log('sent roles:', sent.map((m) => m.role).join(','));
  console.log('sent system content:', JSON.stringify(sent[0].content).slice(0, 200));
  console.log('result msgs roles:', r.messages.map((m) => m.role).join(','));
});
