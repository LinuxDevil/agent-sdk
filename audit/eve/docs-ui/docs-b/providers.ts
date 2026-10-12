// Runtime checks for docs/providers.md claims. No network beyond a local 127.0.0.1 stub.
import { createServer } from 'node:http';
import { createAgent, createMockProvider, resolveProvider, LLMProviderRegistry, OpenAIProvider, fromAiSdk, textOf, estimateTokens } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const log = (l: string, v: unknown) => console.log(`[${l}]`, typeof v === 'string' ? v : JSON.stringify(v));
const clearEnv = () => { for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_BASE_URL', 'LOUSHO_MODEL', 'OPENAI_BASE_URL']) delete process.env[k]; };
clearEnv();
const err = (e: any) => `${e?.name} ${e?.code ?? ''}: ${String(e?.message).split('\n')[0].slice(0, 220)}`;

// missing keys name the variable
for (const spec of ['openai/gpt-4o-mini', 'anthropic/claude-sonnet-5-5', 'openrouter/openai/gpt-4o-mini', 'ollama/llama3.1', 'pi/openrouter/openai/gpt-4o-mini', 'opnai/gpt-4o', 'gpt-4o-mini']) {
  try { const p = resolveProvider(spec); log(`resolve ${spec}`, `OK name=${(p as any).name} model=${(p as any).defaultModel}`); } catch (e) { log(`resolve ${spec}`, err(e)); }
}
// createAgent with neither, nothing set
try { createAgent({}); log('createAgent({}) no env', 'NO THROW'); } catch (e) { log('createAgent({}) no env', err(e)); }
// env order: set OPENROUTER + ANTHROPIC -> which wins?
process.env.OPENROUTER_API_KEY = 'x'; process.env.ANTHROPIC_API_KEY = 'y';
try { const a: any = createAgent({}); log('createAgent({}) anthropic+openrouter env', 'built'); } catch (e) { log('createAgent({}) anthropic+openrouter env', err(e)); }
clearEnv();
process.env.LOUSHO_MODEL = 'openai/gpt-4o-mini';
try { createAgent({}); log('LOUSHO_MODEL w/o key', 'NO THROW (lazy?)'); } catch (e) { log('LOUSHO_MODEL w/o key', err(e)); }
clearEnv();

// createMockProvider snippet
{
  const r = await createAgent({ provider: createMockProvider({ responses: ['Hi! How can I help?'] }) }).send('hello');
  log('createMockProvider responses', r.text);
}

// provider + model override
{
  const m = mockModel(['x']);
  await createAgent({ provider: m, model: 'gpt-4o' }).send('a');
  log('provider+model -> request.model', m.calls[0].model);
}

// LLMProviderRegistry.create
try { const p: any = LLMProviderRegistry.create('openai', { apiKey: 'sk-test', defaultModel: 'gpt-4o-mini' } as any); log('registry.create', `${p.name} ${p.defaultModel}`); } catch (e) { log('registry.create', err(e)); }

// textOf / estimateTokens images
{
  const msg: any = { role: 'user', content: [{ type: 'text', text: 'What is in this picture?' }, { type: 'image', image: 'https://example.com/cat.png' }] };
  log('textOf', textOf(msg));
  try { log('estimateTokens w/ image', (estimateTokens as any)([msg])); } catch (e) { log('estimateTokens', err(e)); }
}

// fromAiSdk misuse
try { fromAiSdk('openai/gpt-4o' as any); log('fromAiSdk(string)', 'NO THROW'); } catch (e) { log('fromAiSdk(string)', err(e)); }

// ---- local stub server for retries / api path ----
const hits: { path: string; body: any }[] = [];
let mode: '503' | 'chat' = '503';
const server = createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  hits.push({ path: req.url!, body: body ? JSON.parse(body) : undefined });
  if (mode === '503') { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'overloaded', type: 'server_error' } })); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'stub-ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as any).port}/v1`;

try {
  // default retries for model strings: 2
  process.env.OPENAI_API_KEY = 'sk-test'; process.env.OPENAI_BASE_URL = base;
  hits.length = 0; mode = '503';
  const evs: string[] = [];
  const t0 = Date.now();
  const r = await createAgent({ model: 'openai/qwen3-8b', onEvent: (e) => { if (e.type.startsWith('provider.')) evs.push(e.type); } }).send('hi').then(() => 'resolved', (e) => err(e));
  log('model-string 503', { r, hits: hits.length, paths: [...new Set(hits.map((h) => h.path))], evs, ms: Date.now() - t0 });

  // retry with provider instance
  hits.length = 0;
  const p = new OpenAIProvider({ apiKey: 'any', baseURL: base, api: 'chat', defaultModel: 'qwen3-8b' } as any);
  const r2 = await createAgent({ provider: p }).send('hi').then(() => 'resolved', (e) => err(e));
  log('provider instance 503 no retry option', { r2, hits: hits.length });
  hits.length = 0;
  const r3 = await createAgent({ provider: p, retry: { maxRetries: 1 } }).send('hi').then(() => 'resolved', (e) => err(e));
  log('provider instance 503 retry:{maxRetries:1}', { r3, hits: hits.length });
  hits.length = 0;
  const r4 = await createAgent({ provider: p, retry: false }).send('hi').then(() => 'resolved', (e) => err(e));
  log('provider instance retry:false', { r4, hits: hits.length });

  // api default responses
  mode = 'chat'; hits.length = 0;
  const pd = new OpenAIProvider({ apiKey: 'any', baseURL: base, defaultModel: 'qwen3-8b' } as any);
  await createAgent({ provider: pd }).send('hi').catch(() => {});
  log('OpenAIProvider default api path', hits.map((h) => h.path));
  hits.length = 0;
  const r5 = await createAgent({ provider: p }).send('hi').then((x) => x.text, (e) => err(e));
  log('api chat path', { paths: hits.map((h) => h.path), r5, model: hits[0]?.body?.model });
  // structured output via chat: response_format sent?
  hits.length = 0;
  const { z } = await import('zod');
  await createAgent({ provider: p, output: z.object({ a: z.string() }) }).send('hi').catch(() => {});
  log('chat response_format', JSON.stringify(hits[0]?.body?.response_format)?.slice(0, 200));
  // provider + model override reaches wire
  hits.length = 0;
  await createAgent({ provider: p, model: 'override-model' }).send('hi').catch(() => {});
  log('wire model override', hits[0]?.body?.model);

  // fallbackModels with model strings
  mode = '503'; hits.length = 0;
  const evs2: string[] = [];
  const r6 = await createAgent({ model: 'openai/m1', fallbackModels: ['openai/m2'], retry: { maxRetries: 0 }, onEvent: (e) => { if (e.type.startsWith('provider.')) evs2.push(e.type + JSON.stringify((e as any)).slice(0, 0)); } }).send('hi').then(() => 'resolved', (e) => err(e));
  log('fallback', { r6, models: hits.map((h) => h.body?.model), evs2 });
} finally {
  server.close();
}
