/**
 * The online-evaluator worker: code rules score new traces whose root ended,
 * through an injected fake sandbox (the real isolate only runs in the compat
 * CI job; see the last block). Also pins that ingest stays 2xx and fast when
 * the worker or its sandbox fails.
 */
import { createRequire } from 'node:module';
import type * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createEvaluatorRule, type EvaluatorRuleFields } from './evaluators';
import {
  rootsEndedIn,
  startEvaluatorWorker,
  toEvaluatorResult,
  type EvaluatorWorker,
  type EvaluatorWorkerOptions,
} from './evaluatorWorker';
import { startObserveDaemon, type ObserveDaemon } from './daemon';
import { ingestBatch, listScores, openDb, type ScoreRow } from './store';
import type { IngestEvent } from './envelope';
import { SandboxError } from '../sandbox';
import type { SqlDatabase } from '../storage/sqlite/driver';
import { ingestRoutes } from './routes/ingest';

const T0 = 1_700_000_000_000;

const dbs: SqlDatabase[] = [];
const workers: EvaluatorWorker[] = [];
const daemons: ObserveDaemon[] = [];
afterEach(async () => {
  while (workers.length > 0) workers.pop()?.stop();
  while (daemons.length > 0) await daemons.pop()?.close();
  while (dbs.length > 0) dbs.pop()?.close();
});

function newDb(): SqlDatabase {
  const db = openDb(':memory:');
  dbs.push(db);
  return db;
}

const rootEnd = (traceId: string, over: Record<string, unknown> = {}): IngestEvent =>
  ({
    type: 'observation',
    data: {
      obs_id: `${traceId}-root`,
      trace_id: traceId,
      agent_id: 'support',
      kind: 'span',
      name: 'invoke_agent refund-bot',
      start: T0,
      end: T0 + 250,
      status: 'ok',
      input: 'hi',
      output: 'hello',
      ...over,
    },
  }) as IngestEvent;

const child = (traceId: string): IngestEvent =>
  ({
    type: 'observation',
    data: {
      obs_id: `${traceId}-tool`,
      trace_id: traceId,
      parent_obs_id: `${traceId}-root`,
      agent_id: 'support',
      kind: 'tool',
      name: 'execute_tool lookup',
      start: T0 + 10,
      end: T0 + 20,
      status: 'error',
      attrs: { error: 'lookup failed' },
    },
  }) as IngestEvent;

const codeRule = (over: Partial<EvaluatorRuleFields> = {}): EvaluatorRuleFields =>
  ({ name: 'len', enabled: true, filter: {}, sample_rate: 1, kind: 'code', config: { source: '(t) => 1' }, ...over }) as EvaluatorRuleFields;

interface Harness {
  db: SqlDatabase;
  worker: EvaluatorWorker;
  runs: Array<{ code: string; trace: Record<string, unknown> }>;
  warnings: string[];
}

/** A worker over a fresh db whose sandbox calls `impl` instead of an isolate. */
function harness(impl: (code: string, trace: Record<string, unknown>) => unknown = () => 1, opts: EvaluatorWorkerOptions = {}): Harness {
  const db = newDb();
  const runs: Harness['runs'] = [];
  const warnings: string[] = [];
  const worker = startEvaluatorWorker(db, {
    isolateAvailable: () => true,
    warn: (message) => warnings.push(message),
    sandbox: (options) => {
      expect(options).toEqual({ driver: 'isolate', timeoutMs: 2000 });
      return {
        driver: 'fake',
        run: async (code, callOpts) => {
          const trace = callOpts?.args?.[0] as Record<string, unknown>;
          runs.push({ code, trace });
          return impl(code, trace);
        },
      };
    },
    ...opts,
  });
  workers.push(worker);
  return { db, worker, runs, warnings };
}

async function ingestAndWait(h: Harness, batch: IngestEvent[]): Promise<void> {
  ingestBatch(h.db, batch);
  h.worker.notifyRootsEnded(rootsEndedIn(batch));
  await h.worker.idle();
}

const onlineScores = (db: SqlDatabase, traceId: string): ScoreRow[] =>
  listScores(db, { trace_id: traceId, source: 'online', limit: 100 }).scores;

describe('evaluator worker', () => {
  it('scores a matching trace once, as an online score named after the rule', async () => {
    const h = harness(() => ({ value: 0.75, comment: 'ok-ish' }));
    createEvaluatorRule(h.db, codeRule({ filter: { agent_id: 'support', status: 'ok', name_contains: 'refund' } }));
    await ingestAndWait(h, [rootEnd('t1'), child('t1')]);

    expect(h.runs).toHaveLength(1);
    expect(h.runs[0].code).toBe('(t) => 1');
    expect(h.runs[0].trace).toMatchObject({
      trace_id: 't1',
      agent_id: 'support',
      name: 'invoke_agent refund-bot',
      status: 'ok',
      start: T0,
      end: T0 + 250,
      duration_ms: 250,
      input: 'hi',
      output: 'hello',
      error_message: 'lookup failed',
    });
    expect((h.runs[0].trace.observations as unknown[]).length).toBe(2);
    expect(onlineScores(h.db, 't1')).toEqual([
      expect.objectContaining({ name: 'len', value: 0.75, comment: 'ok-ish', source: 'online', agent_id: 'support', obs_id: null }),
    ]);
    expect(h.worker.stats()).toMatchObject({ ran: 1, queued: 0, dropped: 0, skipped: 0 });

    // The same root ending again does not score twice.
    await ingestAndWait(h, [rootEnd('t1')]);
    expect(onlineScores(h.db, 't1')).toHaveLength(1);
  });

  it('never scores a trace a filter key rules out', async () => {
    for (const filter of [{ agent_id: 'billing' }, { status: 'error' as const }, { name_contains: 'onboarding' }]) {
      const h = harness();
      createEvaluatorRule(h.db, codeRule({ filter }));
      await ingestAndWait(h, [rootEnd('t1')]);
      expect(h.runs).toEqual([]);
      expect(onlineScores(h.db, 't1')).toEqual([]);
    }
  });

  it('ignores child ends, open roots, disabled rules, judge rules and sample_rate 0', async () => {
    const h = harness();
    createEvaluatorRule(h.db, codeRule({ name: 'off', enabled: false }));
    createEvaluatorRule(h.db, codeRule({ name: 'never', sample_rate: 0 }));
    createEvaluatorRule(h.db, { name: 'judge', enabled: true, filter: {}, sample_rate: 1, kind: 'judge', config: { model: 'm', rubric: 'r' } });
    expect(rootsEndedIn([child('t1'), rootEnd('t2', { end: undefined })])).toEqual([]);
    await ingestAndWait(h, [rootEnd('t1')]);
    expect(h.runs).toEqual([]);
    expect(onlineScores(h.db, 't1')).toEqual([]);
    expect(h.worker.stats()).toMatchObject({ ran: 0, skipped: 0 });
  });

  it('samples with random() < sample_rate', async () => {
    const draws = [0.2, 0.6];
    const h = harness(() => 1, { random: () => draws.shift() ?? 1 });
    createEvaluatorRule(h.db, codeRule({ sample_rate: 0.5 }));
    await ingestAndWait(h, [rootEnd('t1')]);
    await ingestAndWait(h, [rootEnd('t2')]);
    expect(onlineScores(h.db, 't1')).toHaveLength(1);
    expect(onlineScores(h.db, 't2')).toEqual([]);
  });

  it('turns a throwing evaluator into value null with the error kind', async () => {
    const h = harness((code) => {
      if (code.includes('slow')) throw new SandboxError('too slow', 'timeout', 'isolate');
      throw new RangeError('boom');
    });
    createEvaluatorRule(h.db, codeRule({ name: 'throws' }));
    createEvaluatorRule(h.db, codeRule({ name: 'slow', config: { source: '(t) => slow()' } }));
    await ingestAndWait(h, [rootEnd('t1')]);
    const byName = Object.fromEntries(onlineScores(h.db, 't1').map((s) => [s.name, s]));
    expect(byName.throws).toMatchObject({ value: null, comment: 'driver' });
    expect(byName.slow).toMatchObject({ value: null, comment: 'timeout' });
  });

  it('normalizes what an evaluator returns', () => {
    expect(toEvaluatorResult(1)).toEqual({ value: 1, comment: null });
    expect(toEvaluatorResult({ value: null, comment: 7 })).toEqual({ value: null, comment: '7' });
    expect(toEvaluatorResult({ value: 2, comment: 'x'.repeat(2000) }).comment).toHaveLength(1000);
    for (const bad of [Number.NaN, Infinity, 'one', null, undefined, {}, { value: '1' }, [1]]) {
      expect(toEvaluatorResult(bad)).toEqual({ value: null, comment: 'invalid_result' });
    }
  });

  it('skips code rules without the isolate and warns once', async () => {
    const h = harness(() => 1, { isolateAvailable: () => false });
    createEvaluatorRule(h.db, codeRule());
    await ingestAndWait(h, [rootEnd('t1')]);
    await ingestAndWait(h, [rootEnd('t2')]);
    expect(h.runs).toEqual([]);
    expect(onlineScores(h.db, 't1')).toEqual([]);
    expect(h.worker.stats().skipped).toBe(2);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toMatch(/isolated-vm/);
    expect(h.warnings[0]).toMatch(/--no-node-snapshot/);
  });

  it('probes for isolated-vm by default (runs with it, skips without)', async () => {
    const h = harness(() => 1, { isolateAvailable: undefined });
    createEvaluatorRule(h.db, codeRule());
    await ingestAndWait(h, [rootEnd('t1')]);
    expect(h.worker.stats()).toMatchObject(hasIsolatedVm ? { ran: 1, skipped: 0 } : { ran: 0, skipped: 1 });
    expect(h.warnings).toHaveLength(hasIsolatedVm ? 0 : 1);
  });

  it('runOnce serializes dry runs and answers undefined for a trace with no root', async () => {
    let active = 0;
    let peak = 0;
    const h = harness(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return 1;
    });
    const rule = createEvaluatorRule(h.db, codeRule());
    if (rule === undefined) throw new Error('rule not created');
    ingestBatch(h.db, [rootEnd('t1'), child('orphan')]);
    const results = await Promise.all([h.worker.runOnce(rule, 't1'), h.worker.runOnce(rule, 't1'), h.worker.runOnce(rule, 't1')]);
    expect(results).toEqual([1, 1, 1].map((value) => ({ value, comment: null })));
    expect(peak).toBe(1);
    await expect(h.worker.runOnce(rule, 'orphan')).resolves.toBeUndefined();
    await expect(h.worker.runOnce(rule, 'nope')).resolves.toBeUndefined();
    expect(onlineScores(h.db, 't1')).toEqual([]);
  });

  it('drops and counts traces past maxQueue', async () => {
    const h = harness(() => 1, { maxQueue: 2 });
    createEvaluatorRule(h.db, codeRule());
    ingestBatch(h.db, [rootEnd('t1'), rootEnd('t2'), rootEnd('t3')]);
    h.worker.notifyRootsEnded(['t1', 't2', 't3']);
    expect(h.worker.stats()).toMatchObject({ queued: 2, dropped: 1 });
    await h.worker.idle();
    expect(h.worker.stats()).toMatchObject({ queued: 0, dropped: 1, ran: 2 });
    expect(onlineScores(h.db, 't3')).toEqual([]);
  });

  it('runs off the caller: notifyRootsEnded returns before any rule runs', () => {
    const h = harness();
    createEvaluatorRule(h.db, codeRule());
    ingestBatch(h.db, [rootEnd('t1')]);
    h.worker.notifyRootsEnded(['t1']);
    expect(h.runs).toEqual([]);
  });

  it('stop() drops the queue and an in-flight run writes nothing', async () => {
    let release: () => void = () => undefined;
    const h = harness(() => new Promise((resolve) => (release = () => resolve(1))));
    createEvaluatorRule(h.db, codeRule());
    ingestBatch(h.db, [rootEnd('t1'), rootEnd('t2')]);
    h.worker.notifyRootsEnded(['t1', 't2']);
    await new Promise((resolve) => setTimeout(resolve, 10));
    h.worker.stop();
    release();
    await h.worker.idle();
    expect(onlineScores(h.db, 't1')).toEqual([]);
    expect(h.worker.stats()).toMatchObject({ queued: 0, ran: 0 });
    h.worker.notifyRootsEnded(['t2']);
    expect(h.worker.stats().queued).toBe(0);
  });
});

describe('ingest with the evaluator worker', () => {
  it('still answers 202 when the worker throws', async () => {
    const db = newDb();
    let status = 0;
    const res = {
      writeHead(code: number) {
        status = code;
        return res;
      },
      end() {},
    } as unknown as http.ServerResponse;
    const throwing = {
      notifyRootsEnded() {
        throw new Error('worker down');
      },
    } as unknown as EvaluatorWorker;
    await ingestRoutes[0].handle({
      db,
      dbPath: ':memory:',
      req: {} as http.IncomingMessage,
      res,
      params: {},
      query: new URLSearchParams(),
      readBody: () => Promise.resolve(JSON.stringify({ batch: [rootEnd('t1')] })),
      evaluators: throwing,
    });
    expect(status).toBe(202);
  });

  it('a daemon acks fast while a failing sandbox scores the trace null', async () => {
    const daemon = await startObserveDaemon({
      dbPath: ':memory:',
      port: 0,
      sweepIntervalMs: 0,
      evaluators: {
        isolateAvailable: () => true,
        sandbox: () => ({
          driver: 'fake',
          run: async () => {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            throw new SandboxError('driver gone', 'driver', 'isolate');
          },
        }),
      },
    });
    daemons.push(daemon);
    createEvaluatorRule(daemon.db, codeRule());
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batch: [rootEnd('t1')] }),
    });
    expect(res.status).toBe(202);
    expect(Date.now() - started).toBeLessThan(200);
    await daemon.evaluators.idle();
    expect(onlineScores(daemon.db, 't1')).toEqual([expect.objectContaining({ value: null, comment: 'driver' })]);
  });
});

/** The real isolate (compat CI only: isolated-vm installed and NODE_OPTIONS=--no-node-snapshot). */
function probeIsolatedVm(): { ok: boolean } {
  const needsFlag = Number(process.versions.node.split('.')[0]) >= 20;
  const hasFlag = `${process.env.NODE_OPTIONS ?? ''} ${process.execArgv.join(' ')}`.includes('--no-node-snapshot');
  if (needsFlag && !hasFlag) return { ok: false };
  try {
    createRequire(import.meta.url)('isolated-vm');
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
const hasIsolatedVm = probeIsolatedVm().ok;

describe.runIf(hasIsolatedVm)('evaluator worker (real isolate)', () => {
  it('scores a matching trace from the rule source', async () => {
    const db = newDb();
    const worker = startEvaluatorWorker(db);
    workers.push(worker);
    createEvaluatorRule(db, codeRule({ config: { source: '(trace) => ({ value: trace.duration_ms / 1000, comment: trace.name })' } }));
    ingestBatch(db, [rootEnd('t1')]);
    worker.notifyRootsEnded(['t1']);
    await worker.idle();
    expect(onlineScores(db, 't1')).toEqual([expect.objectContaining({ value: 0.25, comment: 'invoke_agent refund-bot' })]);
  });

  it("reports a user-code throw as 'driver' (the isolate passes it through without a kind)", async () => {
    const db = newDb();
    const worker = startEvaluatorWorker(db);
    workers.push(worker);
    createEvaluatorRule(db, codeRule({ config: { source: '() => { throw new Error("boom") }' } }));
    ingestBatch(db, [rootEnd('t1')]);
    worker.notifyRootsEnded(['t1']);
    await worker.idle();
    expect(onlineScores(db, 't1')).toEqual([expect.objectContaining({ value: null, comment: 'driver' })]);
  });
});
