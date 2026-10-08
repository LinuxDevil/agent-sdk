/**
 * Cancellation audit: abort the triage run (a) while a tool is running,
 * (b) while the model is generating, (c) while a tool that IGNORES the abort
 * signal is running. Reports the result/error shape, how long send() took to
 * settle after abort(), whether the HTTP request was torn down (proxy sees the
 * client disconnect) and what the durable checkpoint looks like.
 *
 *   npx tsx log-incident/scenarios/cancel.ts
 */
import { memoryStore } from '@lousho/build-ai-agent';
import { startProxy } from '../proxy.js';

const proxy = await startProxy({ port: 1241, mode: 'pass', quiet: true });
process.env.LOCAL_LLM_BASE_URL = proxy.url;
const { triageAgent, TASK } = await import('../agent.js');
const { toolTap } = await import('../logs.js');

const only = process.argv.slice(2);
async function scenario(name: string, setup: (ac: AbortController, mark: (s: string) => void) => void) {
  if (only.length && !only.includes(name)) return;
  console.log(`\n=== ${name}`);
  const store = memoryStore();
  const ac = new AbortController();
  let abortedAt = 0;
  const marks: string[] = [];
  const t0 = Date.now();
  const mark = (s: string) => marks.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);
  const origAbort = ac.abort.bind(ac);
  ac.abort = (r?: unknown) => { abortedAt = Date.now(); mark('abort()'); origAbort(r); };
  setup(ac, mark);
  const events: string[] = [];
  const agent = triageAgent({
    store,
    quiet: true,
    onEvent: (e) => {
      if (['tool.start', 'tool.done', 'tool.error', 'step.start', 'step.done', 'run.done'].includes(e.type)) {
        events.push(`${e.type}${(e as any).toolName ? ' ' + (e as any).toolName : ''}${(e as any).finishReason ? ' ' + (e as any).finishReason : ''}`);
        mark(e.type + ((e as any).toolName ? ' ' + (e as any).toolName : ''));
      }
      if (e.type === 'step.start') stepStarts.forEach((f) => f((e as any).step));
      if (e.type === 'tool.start') toolStarts.forEach((f) => f((e as any).toolName));
      if (e.type === 'tool.error') console.log('   tool.error payload:', JSON.stringify((e as any).error).slice(0, 300));
    },
  });
  const proxyBefore = proxy.log.length;
  try {
    const r = await agent.send(TASK, { sessionId: name, signal: ac.signal });
    mark('send() resolved');
    console.log(`   resolved: finishReason=${r.finishReason} steps=${r.steps} object=${r.object !== undefined} text=${JSON.stringify(r.text?.slice(0, 80))}`);
    console.log(`   result keys: ${Object.keys(r).join(',')}`);
    const last = r.messages.at(-1) as any;
    console.log(`   last message: role=${last?.role} ${JSON.stringify(last?.content).slice(0, 200)}`);
    const toolMsgs = r.messages.filter((m: any) => m.role === 'tool');
    console.log(`   tool results: ${toolMsgs.map((m: any) => `${m.toolName}=${JSON.stringify(m.content).slice(0, 90)}`).join(' | ')}`);
  } catch (e) {
    mark('send() rejected');
    console.log(`   REJECTED ${(e as Error).name} code=${(e as any).code}: ${(e as Error).message.slice(0, 200)}`);
  }
  if (abortedAt) console.log(`   settle latency after abort(): ${Date.now() - abortedAt} ms`);
  const cp = await store.checkpoints!.load(name);
  console.log(`   checkpoint: status=${(cp as any)?.status} roles=${(cp as any)?.messages?.map((m: any) => m.role[0]).join('')}`);
  await new Promise((r) => setTimeout(r, 300));
  console.log(`   http: ${proxy.log.slice(proxyBefore).map((l) => `#${l.n} status=${l.status ?? '-'} aborted=${!!l.aborted} ms=${l.ms ?? '-'}`).join('; ')}`);
  console.log(`   timeline: ${marks.join(' | ')}`);
  stepStarts.length = 0; toolStarts.length = 0;
  toolTap.onCall = undefined; toolTap.delayMs = undefined;
}
const stepStarts: ((n: number) => void)[] = [];
const toolStarts: ((name: string) => void)[] = [];

// (a) abort while a (signal-aware) tool runs
await scenario('abort-mid-tool', (ac, mark) => {
  let sawAbort = false;
  toolTap.delayMs = 20_000; // tools take 20 s and honour ctx.abortSignal
  toolTap.onCall = (_n, _a, ctx) => { ctx.abortSignal?.addEventListener('abort', () => { sawAbort = true; mark('tool saw abortSignal'); }); if (!ctx.abortSignal) mark('tool has NO abortSignal'); };
  toolStarts.push(() => setTimeout(() => ac.abort(), 1000));
  process.on('beforeExit', () => {});
  void sawAbort;
});

// (b) abort while the model generates (2 s into step 1)
await scenario('abort-mid-generation', (ac) => {
  stepStarts.push((n) => { if (n === 1) setTimeout(() => ac.abort(), 2000); });
});

// (c) abort while a tool that ignores the signal runs
await scenario('abort-mid-tool-ignoring-signal', (ac, mark) => {
  toolTap.onCall = async () => { await new Promise((r) => setTimeout(r, 15_000)); mark('stubborn tool finished'); };
  toolStarts.push(() => setTimeout(() => ac.abort(), 1000));
});

// (d) abort with a reason
await scenario('abort-with-reason', (ac) => {
  stepStarts.push((n) => { if (n === 1) setTimeout(() => ac.abort(new Error('operator cancelled triage')), 1500); });
});

await proxy.close();
process.exit(0);
