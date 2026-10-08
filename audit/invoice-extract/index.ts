/**
 * AP invoice batch: extract -> validate -> route for every fixture, with bounded
 * concurrency and a per-invoice timeout, then a (scripted) human review of the
 * approval queue, invoices.csv, accuracy vs ground truth and batch usage.
 *
 *   npx tsx invoice-extract/index.ts [--concurrency 3] [--timeout 240000] [--only inv-01,inv-16]
 */
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlowExecutor, type FlowExecutionResult } from '@lousho/build-ai-agent/flows';
import { apFlow, makeExtractor, makePayments, makeProvider, makeTools, providerEvents, state, type Doc } from './pipeline.js';
import { TRUTH } from './fixtures/groundTruth.js';
import { FIELDS, score, type Field } from './accuracy.js';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const CONCURRENCY = Number(arg('concurrency', '3'));
const TIMEOUT_MS = Number(arg('timeout', '240000'));
const ONLY = arg('only', '').split(',').filter(Boolean);
const OUT = join(here, 'out');
mkdirSync(OUT, { recursive: true });

/** Bounded-concurrency map preserving order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let inFlight = 0;
  let peak = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        results[i] = await fn(items[i], i);
      } finally {
        inFlight--;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  console.log(`[batch] peak concurrency ${peak}`);
  return results;
}

const fixturesDir = join(here, 'fixtures');
const docs: Doc[] = readdirSync(fixturesDir)
  .filter((f) => /^inv-.*\.(txt|pdf)$/.test(f))
  .map((f) => ({ id: f.replace(/\.(txt|pdf)$/, ''), path: join(fixturesDir, f), kind: f.endsWith('.pdf') ? ('pdf' as const) : ('text' as const) }))
  .filter((d) => ONLY.length === 0 || ONLY.some((o) => d.id.startsWith(o)));

const provider = makeProvider();
const extractor = makeExtractor(provider);
const payments = makePayments(provider);
const toolRegistry = makeTools(extractor, payments);

console.log(`[batch] ${docs.length} documents, concurrency ${CONCURRENCY}, per-invoice timeout ${TIMEOUT_MS}ms`);
const batchStart = Date.now();

const flowResults = await mapLimit(docs, CONCURRENCY, async (doc) => {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  state.set(doc.id, { doc, signal, extractionAttempts: [], usages: [], timings: {} });
  const t0 = Date.now();
  const res: FlowExecutionResult = await FlowExecutor.execute(apFlow, {
    agent: { name: 'ap-pipeline', prompt: 'AP pipeline' }, // a plain config; a createAgent() agent is rejected
    provider,
    toolRegistry,
    variables: { docId: doc.id },
  });
  const s = state.get(doc.id)!;
  s.timings.flowMs = Date.now() - t0;
  const v = s.validation;
  console.log(
    `[flow] ${doc.id.padEnd(28)} ${res.success ? 'ok  ' : 'FAIL'} ${String(s.timings.flowMs).padStart(6)}ms ` +
      `kind=${v?.kind ?? '-'} usd=${v?.amountUsd ?? '-'} flags=[${v?.flags.join(',') ?? ''}] route=${s.route ?? '-'} pay=${s.payment?.finishReason ?? '-'}` +
      (res.success ? '' : ` error=${res.error?.message.slice(0, 160)}`) +
      (signal.aborted ? ' (timed out)' : '')
  );
  return res;
});
const flowWallMs = Date.now() - batchStart;

// ------------------------------------------------------------ human review of the approval queue
const pending = await payments.approvals.list();
console.log(`\n[review] ${pending.length} payments awaiting approval: ${pending.map((p) => `${(p.args as { docId: string }).docId}`).join(', ')}`);
const ids = pending.map((p) => p.id);
console.log(`[review] approval ids unique: ${new Set(ids).size === ids.length}`);
const decisions: Record<string, { approved: boolean; note?: string; finishReason?: string; error?: string }> = {};
for (const p of pending) {
  const docId = (p.args as { docId: string }).docId;
  const s = state.get(docId);
  // Scripted reviewer: approve clean invoices, reject anything with business-rule flags.
  const approved = !!s?.validation && s.validation.flagCount === 0;
  const note = approved ? undefined : `Rejected: ${s?.validation?.details.join('; ') ?? 'no validation'}`;
  try {
    const r = await payments.approvals.resolve({ id: p.id, approved, note });
    s?.usages.push(r.usage);
    decisions[docId] = { approved, note, finishReason: r.finishReason };
  } catch (e) {
    decisions[docId] = { approved, note, error: (e as Error).message };
  }
  console.log(`[review] ${docId}: ${approved ? 'APPROVED' : 'REJECTED'} -> ${decisions[docId].finishReason ?? decisions[docId].error}`);
}
// Payments that ran without approval:
for (const [id, s] of state) {
  if (s.payment && s.payment.finishReason !== 'awaiting-approval' && !decisions[id]) decisions[id] = { approved: true, note: 'auto', finishReason: s.payment.finishReason };
}
const totalWallMs = Date.now() - batchStart;

// ------------------------------------------------------------ state-bleed check (shared extractor across parallel sends)
const bleed: string[] = [];
for (const [id, s] of state) {
  const r = s.extractionResult;
  if (!r) continue;
  const users = r.messages.filter((m) => m.role === 'user').map((m) => JSON.stringify(m.content));
  const own = users.some((u) => u.includes(id));
  const foreign = [...state.keys()].filter((o) => o !== id && users.some((u) => u.includes(`Document id ${o}`)));
  if (!own || foreign.length) bleed.push(`${id}: own=${own} foreign=${foreign.join(',')}`);
  const d = s.extraction?.document;
  const t = TRUTH[id];
  if (d?.kind === 'invoice' && t?.invoiceNumber && TRUTH[id] && Object.entries(TRUTH).some(([o, tt]) => o !== id && tt.invoiceNumber === d.invoiceNumber)) {
    bleed.push(`${id}: extracted invoiceNumber ${d.invoiceNumber} belongs to another document`);
  }
}
console.log(`\n[bleed] ${bleed.length === 0 ? 'no cross-request contamination detected' : bleed.join('\n')}`);

// ------------------------------------------------------------ accuracy
const perField: Record<string, { ok: number; n: number }> = {};
const rows: string[] = [];
let docsPerfect = 0;
let routeOk = 0;
let flagsOk = 0;
for (const doc of docs) {
  const s = state.get(doc.id)!;
  const t = TRUTH[doc.id];
  if (!t) continue;
  const sc = score(s.extraction, t);
  const misses = Object.entries(sc).filter(([, ok]) => !ok).map(([f]) => f);
  if (misses.length === 0) docsPerfect++;
  for (const [f, ok] of Object.entries(sc)) {
    perField[f] ??= { ok: 0, n: 0 };
    perField[f].n++;
    if (ok) perField[f].ok++;
  }
  const gotFlags = [...(s.validation?.flags ?? [])].filter((f) => f !== 'line_math').sort().join(',');
  const wantFlags = [...t.flags].sort().join(',');
  if (gotFlags === wantFlags) flagsOk++;
  if (s.route === t.route) routeOk++;
  rows.push(`${doc.id.padEnd(28)} misses=[${misses.join(',')}] flags got=[${gotFlags}] want=[${wantFlags}] route got=${s.route} want=${t.route}`);
}
console.log('\n[accuracy] per document');
for (const r of rows) console.log('  ' + r);
console.log('[accuracy] per field');
let fOk = 0;
let fN = 0;
for (const f of FIELDS) {
  const p = perField[f as Field];
  if (!p) continue;
  fOk += p.ok;
  fN += p.n;
  console.log(`  ${f.padEnd(14)} ${p.ok}/${p.n}`);
}
console.log(`[accuracy] fields ${fOk}/${fN} = ${((100 * fOk) / fN).toFixed(1)}%  documents fully correct ${docsPerfect}/${docs.length}  flags correct ${flagsOk}/${docs.length}  route correct ${routeOk}/${docs.length}`);

// ------------------------------------------------------------ usage / cost aggregation (no SDK helper: hand-summed)
const all = [...state.values()].flatMap((s) => s.usages);
const sum = (k: 'inputTokens' | 'outputTokens' | 'totalTokens' | 'reasoningTokens' | 'modelCalls') => all.reduce((a, u) => a + (u?.[k] ?? 0), 0);
const costs = all.map((u) => u?.costUsd);
console.log(
  `\n[usage] runs=${all.length} modelCalls=${sum('modelCalls')} in=${sum('inputTokens')} out=${sum('outputTokens')} reasoning=${sum('reasoningTokens')} total=${sum('totalTokens')} ` +
    `costUsd=${costs.every((c) => c === undefined) ? 'undefined (local model has no price)' : costs.reduce((a: number, c) => a + (c ?? 0), 0)} estimated=${all.some((u) => u?.estimated)}`
);
console.log(`[timing] flows ${flowWallMs}ms, with review ${totalWallMs}ms; ${(docs.length / (flowWallMs / 60000)).toFixed(2)} docs/min; ` +
  `extract avg ${Math.round(avg([...state.values()].map((s) => s.timings.extractMs)))}ms, route avg ${Math.round(avg([...state.values()].map((s) => s.timings.routeMs)))}ms`);
console.log(`[provider] retries=${providerEvents.retries.length} fallbacks=${providerEvents.fallbacks.length}`);
for (const f of providerEvents.fallbacks) console.log(`  fallback ${f.from} -> ${f.to}: ${f.error}`);
for (const r of providerEvents.retries) console.log(`  retry #${r.attempt} in ${r.delayMs}ms: ${r.error}`);

function avg(xs: Array<number | undefined>) {
  const v = xs.filter((x): x is number => typeof x === 'number');
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

// ------------------------------------------------------------ invoices.csv
const csvEsc = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const header = ['docId', 'kind', 'invoiceNumber', 'vendor', 'issueDate', 'dueDate', 'currency', 'subtotal', 'taxAmount', 'total', 'amountUsd', 'flags', 'route', 'decision', 'extractMs', 'attempts', 'flowError'];
const lines = [header.join(',')];
docs.forEach((doc, i) => {
  const s = state.get(doc.id)!;
  const d = s.extraction?.document;
  const inv = d?.kind === 'invoice' ? d : undefined;
  const dec = decisions[doc.id];
  lines.push(
    [doc.id, d?.kind ?? 'failed', inv?.invoiceNumber, inv?.vendor.name, inv?.issueDate, inv?.dueDate, inv?.currency, inv?.subtotal, inv?.taxAmount, inv?.total,
      s.validation?.amountUsd, s.validation?.flags.join('|'), s.route, dec ? (dec.approved ? `approved(${dec.note === 'auto' ? 'auto' : 'human'})` : 'rejected') : '',
      s.timings.extractMs, s.extractionAttempts.join('|'), flowResults[i].success ? '' : flowResults[i].error?.message]
      .map(csvEsc)
      .join(',')
  );
});
writeFileSync(join(OUT, 'invoices.csv'), lines.join('\n') + '\n');
writeFileSync(
  join(OUT, `run-${Date.now()}.json`),
  JSON.stringify({ concurrency: CONCURRENCY, flowWallMs, totalWallMs, providerEvents, decisions, docs: [...state.values()].map((s) => ({ id: s.doc.id, extraction: s.extraction, validation: s.validation, route: s.route, payment: s.payment, attempts: s.extractionAttempts, timings: s.timings, outputError: s.extractionResult?.outputError, finishReason: s.extractionResult?.finishReason, steps: s.extractionResult?.steps })) }, null, 1)
);
console.log(`\n[export] ${join(OUT, 'invoices.csv')} (${lines.length - 1} rows)`);
