// CORE: UI state projection (shared by React/Vue/Svelte via src/ui). Deterministic.
// Run: npx tsx eve/core/r9-ui-reducer.ts
import { z } from 'zod';
import { createAgent, defineTool } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { loushoAgent } from '@lousho/build-ai-agent/svelte';

const weather = defineTool({ name: 'weather', description: 'w', input: z.object({ city: z.string() }), execute: async () => ({ tempC: 20 }) });

function watch(agent: any) {
  const store = loushoAgent({ agent });
  let state: any;
  store.subscribe((s) => (state = s));
  return { store, get: () => state };
}

// A: multi-step turn - step texts glued together with no separator, tool order lost
{
  const { store, get } = watch(createAgent({ provider: mockModel([{ text: 'Let me check the weather.', toolCalls: [{ name: 'weather', args: { city: 'Paris' } }] }, 'It is 20C in Paris.']), tools: [weather] }));
  await store.send('Weather in Paris?');
  const a = get().messages.at(-1);
  console.log('A assistant bubble text=%j toolCalls=%j', a.text, a.toolCalls.map((c: any) => c.name));
}

// B: how do non-'stop' endings show up? (status, error)
const endings: Array<[string, any]> = [
  ['max-steps', { provider: mockModel([{ toolCalls: [{ name: 'weather', args: { city: 'x' } }] }], { onExhausted: 'repeat-last' }), tools: [weather], maxSteps: 1 }],
  ['output-invalid', { provider: mockModel(['not json', 'still not json']), output: z.object({ a: z.string() }) }],
  ['budget-exceeded', { provider: mockModel([{ text: 'x', usage: { inputTokens: 500, outputTokens: 500 }, toolCalls: [{ name: 'weather', args: { city: 'x' } }] }], { onExhausted: 'repeat-last' }), tools: [weather], limits: { maxTokens: 10 } }],
  ['provider 401', { provider: mockModel([{ error: Object.assign(new Error('Incorrect API key'), { statusCode: 401 }) }]) }],
];
for (const [label, cfg] of endings) {
  const { store, get } = watch(createAgent(cfg));
  await store.send('go');
  const s = get();
  console.log('B %s -> status=%s error=%j lastEvent=%s(%s) bubble=%j', label.padEnd(15), s.status, s.error, s.lastEvent?.type, s.lastEvent?.finishReason, s.messages.at(-1).text.slice(0, 40));
}

// C: stop() mid-run - does the tool call stay 'running' forever?
{
  const slow = defineTool({ name: 'slow', description: 's', input: z.object({}), execute: async (_a, ctx) => new Promise((r, j) => { const t = setTimeout(() => r('ok'), 2000); ctx.abortSignal?.addEventListener('abort', () => { clearTimeout(t); j(new Error('aborted')); }); }) });
  const { store, get } = watch(createAgent({ provider: mockModel([{ toolCalls: [{ name: 'slow' }] }, 'done']), tools: [slow] }));
  const p = store.send('go');
  await new Promise((r) => setTimeout(r, 100));
  store.stop();
  await p;
  const s = get();
  console.log('C after stop(): status=%s toolCall statuses=%j', s.status, s.messages.at(-1).toolCalls.map((c: any) => c.status));
}
