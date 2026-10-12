// Runtime checks for docs/configuration.md claims.
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  agentSpecSchema, specToAgent, loadSpec, createAgent, defineTool, BudgetExceededError, memoryStore,
  withRetry, withFallback, loadProjectInstructions,
} from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const log = (l: string, v: unknown) => console.log(`[${l}]`, typeof v === 'string' ? v : JSON.stringify(v));
const err = (e: any) => `${e?.name} ${e?.code ?? ''}: ${String(e?.message).split('\n').slice(0, 3).join(' | ').slice(0, 260)}`;
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_BASE_URL', 'LOUSHO_MODEL']) delete process.env[k];

const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
const spec = (name: string, body: string) => { const p = join(dir, name); writeFileSync(p, body); return p; };

// spec validation messages
for (const [n, body] of [
  ['missing-prompt.yaml', 'name: x\nprovider:\n  type: mock\n  model: m\n'],
  ['bad-guardrail.yaml', 'name: x\nprompt: p\nprovider:\n  type: mock\n  model: m\npolicy:\n  guardrails:\n    - deny-topic\n'],
  ['bad-mcp.yaml', 'name: x\nprompt: p\nprovider:\n  type: mock\n  model: m\nmcpServers:\n  files:\n    args: [a]\n'],
  ['github-tool.yaml', 'name: x\nprompt: p\nprovider:\n  type: mock\n  model: m\ntools:\n  - github\n'],
  ['doc-example.yaml', 'name: support-bot\nprompt: You are a friendly support agent.\nprovider:\n  type: mock\n  model: gpt-4o-mini\ntools:\n  - http\npolicy:\n  requiresApproval: [http]\n  guardrails:\n    - secret-scan\n    - name: max-length\n      maxChars: 4000\n      on: input\n    - name: deny-topics\n      topics: [medical advice, legal advice]\n  limits:\n    maxTokens: 50000\n    maxCostUsd: 0.25\n    maxSteps: 10\n  askQuestion: true\n  compaction:\n    thresholdPercent: 0.8\n'],
] as const) {
  try {
    const s = await (loadSpec as any)(spec(n, body));
    try { const a: any = specToAgent(s); log(`spec ${n}`, `OK agent built; tools=${JSON.stringify(Object.keys(a.tools ?? {}))}`); } catch (e) { log(`spec ${n} specToAgent`, err(e)); }
  } catch (e) { log(`spec ${n} loadSpec`, err(e)); }
}

// doc snippet: agentSpecSchema + specToAgent + mcpServers keys
try {
  const s = agentSpecSchema.parse({ name: 'support-bot', prompt: 'p', provider: { type: 'mock', model: 'mock-1' }, mcpServers: { filesystem: { command: 'npx', args: ['-y', 'x'] }, docs: { url: 'https://example.com/mcp' } } });
  const a: any = specToAgent(s);
  log('specToAgent mcpServers keys', Object.keys(a.mcpServers ?? {}));
} catch (e) { log('specToAgent mcp', err(e)); }

// requiresApproval in spec pauses
try {
  const s = agentSpecSchema.parse({ name: 'x', prompt: 'p', provider: { type: 'mock', model: 'm' }, tools: ['current-date'], policy: { requiresApproval: true } });
  const a: any = specToAgent(s);
  const r = await a.send('What is the current date? use current-date');
  log('spec requiresApproval', { fr: r.finishReason, text: String(r.text).slice(0, 80) });
} catch (e) { log('spec requiresApproval', err(e)); }

// missing key error prefix
try { createAgent({ model: 'openai/gpt-4o-mini' }); log('createAgent missing key', 'NO THROW'); } catch (e) { log('createAgent missing key', err(e)); }

// modelSettings merge and omission
{
  const m = mockModel(['a', 'b']);
  const agent = createAgent({ provider: m, modelSettings: { maxTokens: 1024, temperature: 0.2 } });
  await agent.send('x', { modelSettings: { maxTokens: 256 } } as any);
  await agent.send('y');
  const pick = (c: any) => Object.fromEntries(['maxTokens', 'temperature', 'topP', 'seed', 'stop'].filter((k) => k in c).map((k) => [k, c[k]]));
  log('modelSettings call1', pick(m.calls[0]));
  log('modelSettings call2', pick(m.calls[1]));
  const m2 = mockModel(['a']);
  await createAgent({ provider: m2 }).send('x');
  log('no modelSettings keys present', ['maxTokens', 'temperature', 'topP'].filter((k) => k in (m2.calls[0] as any)));
}

// default maxSteps 10 and limits.maxSteps alias
{
  const t = defineTool({ name: 'loop', description: 'x', input: z.object({}), execute: async () => 'ok' });
  const m = mockModel([{ toolCalls: [{ name: 'loop' }] }], { onExhausted: 'repeat-last' });
  const r = await createAgent({ provider: m, tools: [t] }).send('x');
  log('default maxSteps', { fr: r.finishReason, calls: m.calls.length });
  const m2 = mockModel([{ toolCalls: [{ name: 'loop' }] }], { onExhausted: 'repeat-last' });
  const r2 = await createAgent({ provider: m2, tools: [t], limits: { maxSteps: 3 } }).send('x');
  log('limits.maxSteps=3 alone', { fr: r2.finishReason, calls: m2.calls.length, budget: (r2 as any).budget });
  const m3 = mockModel([{ toolCalls: [{ name: 'loop' }] }], { onExhausted: 'repeat-last' });
  const r3 = await createAgent({ provider: m3, tools: [t], limits: { maxSteps: 3 }, maxSteps: 3 }).send('x');
  log('tie maxSteps=3 both', { fr: r3.finishReason, calls: m3.calls.length });
  const m4 = mockModel([{ toolCalls: [{ name: 'loop' }] }], { onExhausted: 'repeat-last' });
  const r4 = await createAgent({ provider: m4, tools: [t], limits: { maxSteps: 2 }, maxSteps: 5 }).send('x');
  log('limits stricter (2 vs 5)', { fr: r4.finishReason, calls: m4.calls.length, budget: (r4 as any).budget });
}

// budget: maxTokens trip; event order; cancelled tool result; throw variant
{
  const t = defineTool({ name: 'loop', description: 'x', input: z.object({}), execute: async () => 'ok' });
  const m = mockModel([{ toolCalls: [{ name: 'loop' }], usage: { inputTokens: 600, outputTokens: 100 } }], { onExhausted: 'repeat-last' });
  const run = createAgent({ provider: m, tools: [t], limits: { maxTokens: 1000 } }).stream('x');
  const types: string[] = [];
  for await (const e of run) types.push(e.type);
  const r: any = await run.result;
  log('budget events tail', types.slice(-5));
  log('budget result', { fr: r.finishReason, budget: r.budget, calls: m.calls.length, lastMsgs: r.messages.slice(-2).map((x: any) => `${x.role}:${String(x.content).slice(0, 60)}`) });
  const m2 = mockModel([{ toolCalls: [{ name: 'loop' }], usage: { inputTokens: 600, outputTokens: 100 } }], { onExhausted: 'repeat-last' });
  try { await createAgent({ provider: m2, tools: [t], limits: { maxTokens: 1000, onExceeded: 'throw' } }).send('Go'); log('throw variant', 'NO THROW'); } catch (e: any) { log('throw variant', { isBEE: e instanceof BudgetExceededError, code: e.code, budget: e.budget }); }
}

// session limits
{
  const m = mockModel([{ text: 'hi', usage: { inputTokens: 50, outputTokens: 10 } }], { onExhausted: 'repeat-last' });
  const agent = createAgent({ provider: m, store: memoryStore(), limits: { maxTokens: 20_000 } });
  const session = agent.session({ id: 'user-42', limits: { maxTokens: 100 } } as any);
  const a: any = await session.send('Hello');
  const b: any = await session.send('Again');
  const c: any = await session.send('Third');
  log('session limits', { a: [a.finishReason, a.budget?.scope], b: [b.finishReason, b.budget?.scope], c: [c.finishReason, c.budget?.scope], calls: m.calls.length });
}

// withRetry: no retry on 401; Retry-After; provider.retry fields
{
  const e401: any = new Error('unauthorized'); e401.statusCode = 401; e401.status = 401;
  const m = mockModel([{ error: e401 }], { onExhausted: 'repeat-last' });
  const r = await createAgent({ provider: withRetry(m, { maxRetries: 2 }) }).send('x').then(() => 'resolved', (e) => err(e));
  log('withRetry 401', { r, calls: m.calls.length });
  const e503: any = new Error('server overloaded'); e503.statusCode = 503; e503.status = 503;
  const m2 = mockModel([{ error: e503 }, 'recovered']);
  const evs: any[] = [];
  const run = createAgent({ provider: m2, retry: { maxRetries: 2, backoff: { initialMs: 10 } } }).stream('x');
  try { for await (const e of run) if (e.type === 'provider.retry') evs.push(e); } catch {}
  log('retry event fields (503 plain Error)', { evs: evs.length, res: await run.result.then((x) => x.text, (e) => err(e)), calls: m2.calls.length });
  // send() with retry
  const m3 = mockModel([{ error: e503 }, 'recovered']);
  const r3 = await createAgent({ provider: m3, retry: { maxRetries: 2, backoff: { initialMs: 10 } } }).send('x').then((x) => x.text, (e) => err(e)); // 503 Error: not retried, see retry-custom.ts
  log('send with retry 503', { r3, calls: m3.calls.length });
  // fallback event from/to
  const fa = mockModel([{ error: new Error('boom') }]);
  const fb = mockModel(['from-b']);
  const fevs: any[] = [];
  const run2 = createAgent({ provider: withFallback([fa, fb]) }).stream('x');
  for await (const e of run2) if (e.type === 'provider.fallback') fevs.push({ from: (e as any).from, to: (e as any).to });
  log('withFallback in stream', { fevs, text: (await run2.result).text });
}

// projectInstructions
{
  const root = mkdtempSync(join(tmpdir(), 'proj-'));
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, 'pkg', 'api'), { recursive: true });
  writeFileSync(join(root, 'AGENTS.md'), 'Always be terse.');
  writeFileSync(join(root, 'pkg', 'CLAUDE.md'), 'Claude file in pkg.');
  const m = mockModel(['ok']);
  await createAgent({ instructions: 'You review pull requests.', provider: m, projectInstructions: { cwd: join(root, 'pkg', 'api') } }).send('x');
  log('projectInstructions sys', String(m.calls[0].messages[0].content).replace(/\n/g, '\\n').slice(0, 200));
  log('loadProjectInstructions', (loadProjectInstructions as any)({ cwd: join(root, 'pkg', 'api'), files: ['AGENTS.md'] }));
  const big = mkdtempSync(join(tmpdir(), 'big-')); mkdirSync(join(big, '.git')); writeFileSync(join(big, 'AGENTS.md'), 'x'.repeat(40_000));
  const r = (loadProjectInstructions as any)({ cwd: big });
  log('truncation', { len: r?.content?.length, tail: r?.content?.slice(-80) });
}
