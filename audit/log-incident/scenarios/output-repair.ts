/**
 * Structured-output repair audit.
 *
 * Part 1 (offline, mockModel): which "almost JSON" replies does the SDK accept
 * without a repair step, and which need one?
 * Part 2 (local model): corrupt the 9B model's final answer on the wire (a
 * provider wrapper), and check the [output-invalid] repair step fixes it; then
 * corrupt every answer and check the output-invalid result shape.
 *
 *   STREAM=0 npx tsx log-incident/scenarios/output-repair.ts [offline|live]
 */
import { createAgent, type LLMProvider, type Message } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { IncidentReport } from '../logs.js';

const valid = {
  title: 'Checkout outage', severity: 'SEV1', impactStart: '2026-09-30T14:10:40Z', impactEnd: '2026-09-30T14:41:00Z',
  timeline: [{ time: '14:02', event: 'deploy v2.41.0' }, { time: '14:11', event: 'too many clients' }, { time: '14:38', event: 'rollback' }],
  rootCause: 'pg client leak in v2.41.0 checkout', trigger: 'deploy v2.41.0',
  blastRadius: { affectedEndpoints: ['/api/checkout'], unaffected: ['/healthz'], peak5xxPerMinute: 120 },
  evidence: [{ source: 'postgres', line: 'FATAL: sorry, too many clients already' }, { source: 'app', line: 'deploy started v2.41.0' }],
  remediation: ['rollback'],
};
const J = JSON.stringify(valid);
const mode = process.argv[2] ?? 'all';

if (mode === 'offline' || mode === 'all') {
  const variants: [string, string][] = [
    ['plain JSON', J],
    ['```json fence', '```json\n' + J + '\n```'],
    ['prose prefix', 'Here is the incident report:\n' + J],
    ['fence + trailing prose', '```json\n' + J + '\n```\nLet me know if you need more detail.'],
    ['<think> block before JSON', '<think>The deploy at 14:02 caused it.</think>\n' + J],
    ['trailing comma', J.replace(/]}$/, '],}')],
    ['string number (peak5xxPerMinute:"120")', J.replace('"peak5xxPerMinute":120', '"peak5xxPerMinute":"120"')],
    ['wrong enum (severity:"critical")', J.replace('"SEV1"', '"critical"')],
    ['JSON array wrapper', '[' + J + ']'],
  ];
  console.log('=== offline: first reply variant -> did the SDK accept it, or send a repair step?');
  for (const [name, first] of variants) {
    const seen: string[] = [];
    const agent = createAgent({ provider: mockModel([first, J]), output: IncidentReport, hooks: [{ name: 'spy', preGenerate: (ctx) => { const last = ctx.request.messages.at(-1) as Message; if (typeof last.content === 'string' && last.content.startsWith('[output-invalid]')) seen.push(last.content); } }] });
    const r = await agent.send('report');
    console.log(`- ${name.padEnd(42)} finish=${r.finishReason} steps=${r.steps} repaired=${seen.length > 0}${seen[0] ? ' repairMsg=' + JSON.stringify(seen[0].slice(0, 150)) : ''}`);
  }
  // both replies invalid -> output-invalid shape
  const agent = createAgent({ provider: mockModel(['not json', '{"title":1}']), output: IncidentReport });
  const r = await agent.send('report');
  console.log(`\n- both invalid: finish=${r.finishReason} object=${r.object} text=${JSON.stringify(r.text?.slice(0, 40))}\n  outputError=${JSON.stringify(r.outputError).slice(0, 600)}`);
  // repair counts against maxSteps: with maxSteps 1 there is no repair step
  const a1 = createAgent({ provider: mockModel(['not json', J]), output: IncidentReport, maxSteps: 1 });
  const r1 = await a1.send('report');
  console.log(`- maxSteps 1, invalid first reply: finish=${r1.finishReason} steps=${r1.steps}`);
}

if (mode === 'live' || mode === 'all') {
  const { capped, provider0 } = await import('../agent.js');
  /** Corrupts the text of final (tool-call-free) answers, `times` times. */
  function corrupting(p: LLMProvider, how: (t: string) => string, times: number) {
    let left = times;
    const calls: { in: string; out: string }[] = [];
    const wrapped = new Proxy(p, {
      get(t, k, r) {
        if (k === 'supportsStreaming') return () => false;
        if (k === 'generate') return async (o: any) => {
          const res = await t.generate(o);
          const before = res.text;
          if (left > 0 && !(res.toolCalls?.length) && res.text) { left--; res.text = how(res.text); }
          calls.push({ in: before.slice(0, 80), out: res.text.slice(0, 80) });
          return res;
        };
        const v = Reflect.get(t, k, r);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    return { wrapped, calls };
  }
  const facts = `Facts (already investigated, do not call tools): deploy of api v2.41.0 (commit 9f3c2e1) at 2026-09-30T14:02:13Z; pg pool waitingCount grew on new pods;
HPA scaled 4->8 pods at 14:09:02; first "timeout exceeded when trying to connect" at 14:10:40 on /api/checkout; postgres "FATAL: sorry, too many clients already" from 14:11;
5xx peaked ~110/min on /api/checkout,/api/orders,/api/cart,/api/products; /healthz and /static stayed 200; restart at 14:24 helped briefly; rollback to v2.40.3 at 14:38:05, recovered 14:41.
Write the incident report now.`;
  for (const [name, how, times] of [
    ['truncated JSON (cut at 60%)', (t: string) => t.slice(0, Math.floor(t.length * 0.6)), 1],
    ['prose before JSON', (t: string) => 'Here is the incident report you asked for:\n\n' + t, 1],
    ['missing required field (drop rootCause)', (t: string) => { try { const o = JSON.parse(t.replace(/^```json|```$/g, '')); delete o.rootCause; return JSON.stringify(o); } catch { return t; } }, 1],
    ['always corrupt (no recovery possible)', (t: string) => t.slice(0, 20), 99],
  ] as const) {
    const { wrapped, calls } = corrupting(capped(provider0()), how, times);
    const agent = createAgent({ provider: wrapped, output: IncidentReport, instructions: 'You are an SRE writing an incident report.', retry: { maxRetries: 6, backoff: { initialMs: 2000 }, retryOn: () => true } });
    const t0 = Date.now();
    try {
      const r = await agent.send(facts);
      console.log(`\n=== live: ${name}\n   finish=${r.finishReason} steps=${r.steps} object=${!!r.object} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      const repair = r.messages.find((m) => typeof m.content === 'string' && m.content.startsWith('[output-invalid]'));
      console.log(`   repair message: ${repair ? JSON.stringify((repair.content as string).slice(0, 220)) : '(none)'}`);
      if (r.outputError) console.log(`   outputError: ${JSON.stringify(r.outputError).slice(0, 300)}`);
      if (r.object) console.log(`   object.rootCause: ${r.object.rootCause.slice(0, 120)}`);
      console.log(`   model calls: ${calls.map((c) => `[${JSON.stringify(c.out.slice(0, 50))}]`).join(' ')}`);
    } catch (e) {
      console.log(`\n=== live: ${name}\n   THREW ${(e as Error).message.slice(0, 200)}`);
    }
  }
}
process.exit(0);
