import { createAgent, createMockProvider } from '@lousho/build-ai-agent';
const keys = ['OPENAI_API_KEY','ANTHROPIC_API_KEY','OPENROUTER_API_KEY','OLLAMA_BASE_URL','LOUSHO_MODEL','OLLAMA_HOST'];
for (const k of keys) delete process.env[k];
async function tryIt(label: string, fn: () => Promise<unknown>) {
  try { const r = await fn(); console.log(label, '-> OK', r); }
  catch (e: any) { console.log(label, '-> THROW', e?.name, e?.code, '|', String(e?.message).slice(0, 300), '| hint:', e?.hint); }
}
await tryIt('no model, no env (create)', async () => { const a = createAgent({}); return 'created'; });
await tryIt('no model, no env (send)', async () => (await createAgent({}).send('hi')).text);
await tryIt('misspelled prefix', async () => (await createAgent({ model: 'opnai/gpt-4o-mini' }).send('hi')).text);
await tryIt('no prefix', async () => (await createAgent({ model: 'gpt-4o-mini' }).send('hi')).text);
await tryIt('openai missing key', async () => (await createAgent({ model: 'openai/gpt-4o-mini' }).send('hi')).text);
process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:9';
process.env.ANTHROPIC_API_KEY = 'x';
await tryIt('env order: ANTHROPIC + OLLAMA set, which wins?', async () => { const a: any = createAgent({}); const r = await a.send('hi').catch((e: any) => e); return String(r?.message ?? r?.text).slice(0, 200); });
delete process.env.ANTHROPIC_API_KEY; delete process.env.OLLAMA_BASE_URL;
process.env.LOUSHO_MODEL = 'mock/mock-1';
await tryIt('LOUSHO_MODEL=mock/mock-1', async () => (await createAgent({}).send('hi')).text);
delete process.env.LOUSHO_MODEL;
// prompt + instructions both
const prov = createMockProvider({ responses: ['x'] });
await tryIt('prompt+instructions', async () => { const a = createAgent({ prompt: 'P', instructions: 'I', provider: prov } as any); await a.send('hi'); return (prov as any).lastRequest ?? 'n/a'; });
// stream: word by word?
const a2 = createAgent({ prompt: 'x', provider: createMockProvider({ responses: ['Streaming works word by word.'] }) });
const types: string[] = []; let deltas = 0;
for await (const e of a2.stream('hi')) { types.push(e.type); if (e.type === 'text.delta') deltas++; }
console.log('stream event types', [...new Set(types)].join(','), 'deltas', deltas);
