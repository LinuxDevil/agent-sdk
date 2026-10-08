/**
 * Resilience audit: retry/timeouts against a broken or slow local server.
 *
 *   npx tsx log-incident/scenarios/resilience.ts [case...]
 *
 * cases: badport fail500 fail500-stream sseerr-stream sseerr-generate hang-timeout slow-timeout nested-retries
 */
import { createAgent, OpenAIProvider, type AgentEvent } from '@lousho/build-ai-agent';
import { startProxy } from '../proxy.js';
import { LOCAL_MODEL } from '../../_shared/local.js';
import { searchLogs } from '../logs.js';

const proxy = await startProxy({ port: 1242, mode: 'pass' });
const prov = (baseURL: string, maxRetries = 0) => new OpenAIProvider({ apiKey: 'lm-studio', baseURL, defaultModel: LOCAL_MODEL, maxRetries });
const noStream = <T extends object>(p: T): T => new Proxy(p, { get: (t, k, r) => (k === 'supportsStreaming' ? () => false : typeof Reflect.get(t, k, r) === 'function' ? (Reflect.get(t, k, r) as Function).bind(t) : Reflect.get(t, k, r)) });

async function run(name: string, mode: string, make: () => ReturnType<typeof createAgent>, opts: { stream?: boolean; signal?: AbortSignal } = {}) {
  console.log(`\n=== ${name} (proxy mode ${mode})`);
  proxy.setMode(mode);
  const before = proxy.log.length;
  const events: string[] = [];
  const agent = make();
  const t0 = Date.now();
  try {
    let r;
    if (opts.stream) {
      const run = agent.stream('Reply with exactly: OK', { signal: opts.signal });
      for await (const e of run as AsyncIterable<AgentEvent>) if (e.type === 'provider.retry') events.push(`retry#${(e as any).attempt} ${(e as any).delayMs}ms`);
      r = await run.result;
    } else r = await agent.send('Reply with exactly: OK', { signal: opts.signal });
    console.log(`   OK finish=${r.finishReason} text=${JSON.stringify(r.text?.slice(0, 40))} usage=${JSON.stringify(r.usage)}`);
  } catch (e: any) {
    console.log(`   THREW ${e.name} code=${e.code} category=${e.compacted?.category} retryable=${e.compacted?.retryable} msg=${String(e.message).slice(0, 160)}`);
  }
  console.log(`   ${((Date.now() - t0) / 1000).toFixed(1)}s, http requests=${proxy.log.length - before}${events.length ? ', stream events: ' + events.join(' ') : ''}`);
}
const retries: string[] = [];
const retry = (extra: object = {}) => ({ maxRetries: 2, backoff: { initialMs: 300, jitter: false }, onRetry: (i: any) => retries.push(`attempt ${i.attempt} failed (${String(i.error?.message).slice(0, 60)}), wait ${i.delayMs}ms`), ...extra });
const cases = process.argv.slice(2);
const want = (c: string) => cases.length === 0 || cases.includes(c);
const flush = () => { if (retries.length) console.log('   onRetry: ' + retries.splice(0).join(' | ')); };

if (want('badport')) {
  await run('nothing listening on :1299', 'pass', () => createAgent({ provider: prov('http://localhost:1299/v1'), retry: retry() }));
  flush();
}
if (want('fail500')) {
  await run('two HTTP 500s then OK (generate path)', 'fail500:2', () => createAgent({ provider: noStream(prov(proxy.url)), retry: retry() }));
  flush();
}
if (want('fail500-stream')) {
  proxy.log.length = 0;
  await run('two HTTP 500s then OK (agent.stream)', 'fail500:2', () => createAgent({ provider: prov(proxy.url), retry: retry() }), { stream: true });
  flush();
}
if (want('sseerr-stream')) {
  proxy.log.length = 0;
  await run('HTTP 200 + mid-stream error event, once (agent.stream)', 'sseerr:1', () => createAgent({ provider: prov(proxy.url), retry: retry() }), { stream: true });
  flush();
  proxy.log.length = 0;
  await run('HTTP 200 + mid-stream error event, once (send() with onEvent => streams)', 'sseerr:1', () => createAgent({ provider: prov(proxy.url), retry: retry(), onEvent: () => {} }));
  flush();
}
if (want('sseerr-generate')) {
  proxy.log.length = 0;
  await run('mid-stream error, generate path (send(), no listener)', 'sseerr:1', () => createAgent({ provider: prov(proxy.url), retry: retry() }));
  flush();
}
if (want('hang-timeout')) {
  await run('server hangs, retry.timeoutMs=3000', 'hang', () => createAgent({ provider: noStream(prov(proxy.url)), retry: retry({ timeoutMs: 3000, maxRetries: 1 }) }));
  flush();
  await run('server hangs, send({signal: AbortSignal.timeout(4000)}), no retry timeout', 'hang', () => createAgent({ provider: prov(proxy.url), retry: retry({ maxRetries: 1 }) }), { signal: AbortSignal.timeout(4000) });
  flush();
}
if (want('slow-timeout')) {
  await run('queued server (8 s before headers), retry.timeoutMs=3000', 'slow:8000', () => createAgent({ provider: noStream(prov(proxy.url)), retry: retry({ timeoutMs: 3000 }) }));
  flush();
}
if (want('nested-retries')) {
  proxy.log.length = 0;
  await run('always 500, OpenAIProvider default maxRetries (2) + createAgent retry maxRetries 2', 'fail500:99', () => createAgent({ provider: noStream(prov(proxy.url, 2)), retry: retry() }));
  flush();
  proxy.log.length = 0;
  await run('always 500, provider instance with NO createAgent retry (provider default maxRetries)', 'fail500:99', () => createAgent({ provider: noStream(new OpenAIProvider({ apiKey: 'x', baseURL: proxy.url, defaultModel: LOCAL_MODEL })) }));
  flush();
}
if (want('tool-run')) {
  // retries in the middle of a tool-using run: is usage counted once? is the tool re-run?
  let toolRuns = 0;
  const tool = { ...searchLogs, execute: async (a: any, c: any) => { toolRuns++; return searchLogs.execute(a, c); } };
  proxy.log.length = 0;
  proxy.setMode('pass');
  const agent = createAgent({ provider: noStream(prov(proxy.url)), tools: [tool as any], retry: retry(), instructions: 'Use search_logs once with pattern "deploy started" (limit 2), then answer in one sentence.' });
  // fail the 2nd model call twice
  let n = 0;
  const origMode = 'pass';
  const hookAgent = createAgent({
    provider: noStream(prov(proxy.url)), tools: [tool as any], retry: retry(), instructions: 'Use search_logs once with pattern "deploy started" (limit 2), then answer in one sentence.',
    hooks: [{ name: 'flip', preGenerate: () => { n++; proxy.setMode(n === 2 ? 'fail500:' + (proxy.log.length + 2) : origMode); } } as any],
  });
  void agent;
  const t0 = Date.now();
  try {
    const r = await hookAgent.send('When was the deploy?');
    console.log(`\n=== retry inside tool run: finish=${r.finishReason} toolRuns=${toolRuns} steps=${r.steps} usage=${JSON.stringify(r.usage)} http=${proxy.log.map((l) => l.status).join(',')} ${(Date.now() - t0) / 1000}s`);
  } catch (e: any) { console.log('THREW', e.message); }
  flush();
}
await proxy.close();
process.exit(0);
