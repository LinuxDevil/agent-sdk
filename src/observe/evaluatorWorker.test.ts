/**
 * The online-evaluator worker: code rules score new traces whose root ended,
 * through an injected fake sandbox (the real isolate only runs in the compat
 * CI job; see the last block). Also pins that ingest stays 2xx and fast when
 * the worker or its sandbox fails.
 */
import { createRequire } from 'node:module';
import type * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createEvaluatorRule, deleteEvaluatorRule, updateEvaluatorRule, type EvaluatorRuleFields } from './evaluators';
import {
  rootsEndedIn,
  startEvaluatorWorker,
  toEvaluatorResult,
  type EvaluatorWorker,
  type EvaluatorWorkerOptions,
} from './evaluatorWorker';
import { startObserveDaemon, type ObserveDaemon } from './daemon';
import { evaluatorTraceFrom } from './evaluatorTrace';
import { ingestBatch, listScores, openDb, traceDetail, type ScoreRow } from './store';
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

  it('ignores child ends, open roots, disabled rules and sample_rate 0; never runs a judge rule itself', async () => {
    const h = harness();
    createEvaluatorRule(h.db, codeRule({ name: 'off', enabled: false }));
    createEvaluatorRule(h.db, codeRule({ name: 'never', sample_rate: 0 }));
    createEvaluatorRule(h.db, { name: 'judge', enabled: true, filter: {}, sample_rate: 1, kind: 'judge', config: { model: 'm', rubric: 'r' } });
    expect(rootsEndedIn([child('t1'), rootEnd('t2', { end: undefined })])).toEqual([]);
    await ingestAndWait(h, [rootEnd('t1')]);
    expect(h.runs).toEqual([]);
    expect(onlineScores(h.db, 't1')).toEqual([]);
    expect(h.worker.stats()).toMatchObject({ ran: 0, skipped: 0, judge_queued: 1 });
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

const judgeRule = (over: Partial<EvaluatorRuleFields> = {}): EvaluatorRuleFields =>
  ({ name: 'helpful', enabled: true, filter: {}, sample_rate: 1, kind: 'judge', config: { model: 'mock', rubric: 'Is it helpful?' }, ...over }) as EvaluatorRuleFields;

describe('judge jobs', () => {
  /** A harness whose judge leases run on a clock the test moves. */
  function judgeHarness(opts: EvaluatorWorkerOptions = {}): Harness & { clock: { now: number } } {
    const clock = { now: T0 };
    return { ...harness(() => 1, { now: () => clock.now, ...opts }), clock };
  }

  it('a matching judge rule queues one job and writes no score until a result', async () => {
    const h = judgeHarness();
    const rule = createEvaluatorRule(h.db, judgeRule({ filter: { agent_id: 'support' } }));
    createEvaluatorRule(h.db, judgeRule({ name: 'other-agent', filter: { agent_id: 'billing' } }));
    await ingestAndWait(h, [rootEnd('t1'), child('t1')]);
    // The same root ending again does not queue a second job.
    await ingestAndWait(h, [rootEnd('t1')]);
    expect(h.runs).toEqual([]);
    expect(onlineScores(h.db, 't1')).toEqual([]);
    expect(h.worker.stats()).toMatchObject({ judge_queued: 1, judge_leased: 0, ran: 0 });

    const [job, ...rest] = h.worker.claimJudgeJobs(5, 60_000);
    expect(rest).toEqual([]);
    expect(job.rule).toEqual(rule);
    expect(job.trace).toMatchObject({ trace_id: 't1', agent_id: 'support', status: 'ok', input: 'hi', output: 'hello', error_message: 'lookup failed' });
    // Judge jobs carry no observations: Studio's judge reads only the root fields.
    expect(job.trace.observations).toEqual([]);
    expect(h.worker.stats()).toMatchObject({ judge_queued: 0, judge_leased: 1 });
    // Leased, so still deduped.
    await ingestAndWait(h, [rootEnd('t1')]);
    expect(h.worker.stats()).toMatchObject({ judge_queued: 0, judge_leased: 1 });

    const scoreId = h.worker.completeJudgeJob(job.job_id, { value: 0.8, comment: 'clear answer' });
    expect(typeof scoreId).toBe('string');
    expect(onlineScores(h.db, 't1')).toEqual([
      expect.objectContaining({ score_id: scoreId, name: 'helpful', value: 0.8, comment: 'clear answer', source: 'online', agent_id: 'support' }),
    ]);
    expect(h.worker.stats()).toMatchObject({ judge_queued: 0, judge_leased: 0, judge_scored: 1 });
    // Scored now: a new root end queues nothing, and the job is gone.
    await ingestAndWait(h, [rootEnd('t1')]);
    expect(h.worker.stats().judge_queued).toBe(0);
    expect(h.worker.completeJudgeJob(job.job_id, { value: 1, comment: null })).toBeUndefined();
  });

  it('an expired lease goes back to the front of the queue and its late result is refused', async () => {
    const h = judgeHarness();
    createEvaluatorRule(h.db, judgeRule());
    await ingestAndWait(h, [rootEnd('t1'), rootEnd('t2')]);
    await ingestAndWait(h, [rootEnd('t3')]);
    const first = h.worker.claimJudgeJobs(1, 1000);
    expect(first.map((j) => j.trace.trace_id)).toEqual(['t1']);
    h.clock.now += 500;
    expect(h.worker.claimJudgeJobs(1, 1000).map((j) => j.trace.trace_id)).toEqual(['t2']);
    h.clock.now += 600; // t1's lease is over, t2's is not
    expect(h.worker.stats()).toMatchObject({ judge_queued: 2, judge_leased: 1 });
    expect(h.worker.completeJudgeJob(first[0].job_id, { value: 1, comment: null })).toBeUndefined();
    const again = h.worker.claimJudgeJobs(5, 1000);
    expect(again.map((j) => j.trace.trace_id)).toEqual(['t1', 't3']);
    expect(again[0].job_id).toBe(first[0].job_id);
    expect(h.worker.completeJudgeJob(first[0].job_id, { value: null, comment: 'invalid_judge_output' })).toEqual(expect.any(String));
    expect(onlineScores(h.db, 't1')).toEqual([expect.objectContaining({ value: null, comment: 'invalid_judge_output' })]);
  });

  it('drops and counts a job past maxJudgeJobs (pending + leased)', async () => {
    const h = judgeHarness({ maxJudgeJobs: 2 });
    createEvaluatorRule(h.db, judgeRule());
    await ingestAndWait(h, [rootEnd('t1')]);
    h.worker.claimJudgeJobs(1, 60_000);
    await ingestAndWait(h, [rootEnd('t2'), rootEnd('t3')]);
    expect(h.worker.stats()).toMatchObject({ judge_queued: 1, judge_leased: 1, judge_dropped: 1 });
  });

  it('holds 500 jobs by default: the 501st drops and counts', async () => {
    const h = judgeHarness();
    createEvaluatorRule(h.db, judgeRule());
    await ingestAndWait(h, Array.from({ length: 501 }, (_, i) => rootEnd(`t${i}`)));
    expect(h.worker.stats()).toMatchObject({ judge_queued: 500, judge_dropped: 1 });
  });

  it('discards a job at claim time whose rule was deleted, disabled or switched to code', async () => {
    const h = judgeHarness();
    const gone = createEvaluatorRule(h.db, judgeRule({ name: 'gone' }));
    const off = createEvaluatorRule(h.db, judgeRule({ name: 'off' }));
    const switched = createEvaluatorRule(h.db, judgeRule({ name: 'switched' }));
    const kept = createEvaluatorRule(h.db, judgeRule({ name: 'kept' }));
    await ingestAndWait(h, [rootEnd('t1')]);
    expect(h.worker.stats().judge_queued).toBe(4);
    deleteEvaluatorRule(h.db, gone?.rule_id ?? '');
    updateEvaluatorRule(h.db, off?.rule_id ?? '', judgeRule({ name: 'off', enabled: false }));
    updateEvaluatorRule(h.db, switched?.rule_id ?? '', codeRule({ name: 'switched' }));
    const jobs = h.worker.claimJudgeJobs(5, 60_000);
    expect(jobs.map((j) => j.rule.rule_id)).toEqual([kept?.rule_id]);
    expect(h.worker.stats()).toMatchObject({ judge_queued: 0, judge_leased: 1, judge_discarded: 3 });
  });

  it('stop() clears judge jobs and refuses claims and results', async () => {
    const h = judgeHarness();
    createEvaluatorRule(h.db, judgeRule());
    await ingestAndWait(h, [rootEnd('t1'), rootEnd('t2')]);
    const [job] = h.worker.claimJudgeJobs(1, 60_000);
    h.worker.stop();
    expect(h.worker.claimJudgeJobs(5, 60_000)).toEqual([]);
    expect(h.worker.completeJudgeJob(job.job_id, { value: 1, comment: null })).toBeUndefined();
    expect(h.worker.stats()).toMatchObject({ judge_queued: 0, judge_leased: 0 });
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

/** Observation rows `traceId` gets past its root: `count` children, one ms apart. */
const children = (traceId: string, count: number, over: (i: number) => Record<string, unknown> = () => ({})): IngestEvent[] =>
  Array.from(
    { length: count },
    (_, i) =>
      ({
        type: 'observation',
        data: {
          obs_id: `${traceId}-c${i}`,
          trace_id: traceId,
          parent_obs_id: `${traceId}-root`,
          agent_id: 'support',
          kind: 'span',
          name: `step ${i}`,
          start: T0 + 1 + i,
          end: T0 + 2 + i,
          status: 'ok',
          attrs: { step: i, note: 'n'.repeat(200) },
          ...over(i),
        },
      }) as IngestEvent
  );

/** `db`, recording every statement it prepares and the args each run passed. */
function recordingDb(db: SqlDatabase): { db: SqlDatabase; calls: Array<{ sql: string; args: unknown[] }> } {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const wrapped: SqlDatabase = {
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
    prepare(sql) {
      const stmt = db.prepare(sql);
      const record = (args: unknown[]): void => void calls.push({ sql, args });
      return {
        run: (...args) => (record(args), stmt.run(...args)),
        get: (...args) => (record(args), stmt.get(...args)),
        all: (...args) => (record(args), stmt.all(...args)),
      };
    },
  };
  return { db: wrapped, calls };
}

describe('evaluator worker load', () => {
  it('1000 queued traces with a filtered-out rule never hold the event loop past 50 ms a turn', async () => {
    const h = harness();
    createEvaluatorRule(h.db, codeRule({ filter: { agent_id: 'billing' } }));
    const ids: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const id = `load-${i}`;
      ids.push(id);
      ingestBatch(h.db, [rootEnd(id), ...children(id, 12)]);
    }
    let longest = 0;
    let last = performance.now();
    let probing = true;
    const probe = (): void => {
      const at = performance.now();
      longest = Math.max(longest, at - last);
      last = at;
      if (probing) setImmediate(probe);
    };
    setImmediate(probe);
    h.worker.notifyRootsEnded(ids);
    await h.worker.idle();
    // One more turn so the probe measures the gap the drain's last turn left.
    await new Promise((resolve) => setImmediate(resolve));
    probing = false;
    expect(h.worker.stats()).toMatchObject({ queued: 0, ran: 0 });
    expect(h.runs).toEqual([]);
    expect(longest).toBeLessThan(50);
  });

  it('a filtered-out trace loads only its root row: no observation rows, no scores', async () => {
    const base = newDb();
    const rec = recordingDb(base);
    const worker = startEvaluatorWorker(rec.db, { isolateAvailable: () => true, warn: () => undefined });
    workers.push(worker);
    createEvaluatorRule(base, codeRule({ filter: { agent_id: 'billing' } }));
    ingestBatch(base, [rootEnd('t1'), ...children('t1', 5)]);
    rec.calls.length = 0;
    worker.notifyRootsEnded(['t1']);
    await worker.idle();
    const observationReads = rec.calls.filter((c) => /FROM observations/.test(c.sql));
    expect(observationReads).toHaveLength(1);
    expect(observationReads[0].sql).toMatch(/parent_obs_id IS NULL/);
    expect(observationReads[0].sql).toMatch(/LIMIT 1/);
    expect(rec.calls.filter((c) => /FROM scores/.test(c.sql))).toEqual([]);
  });

  it('a code rule gets the first 200 observations, attrs past 8192 chars capped, and the error of a row past 200', async () => {
    const base = newDb();
    const rec = recordingDb(base);
    const runs: Array<Record<string, unknown>> = [];
    const worker = startEvaluatorWorker(rec.db, {
      isolateAvailable: () => true,
      warn: () => undefined,
      sandbox: () => ({
        driver: 'fake',
        run: async (_code, callOpts) => {
          runs.push(callOpts?.args?.[0] as Record<string, unknown>);
          return 1;
        },
      }),
    });
    workers.push(worker);
    const rule = createEvaluatorRule(base, codeRule());
    if (rule === undefined) throw new Error('rule not created');
    const rows = children('t1', 260, (i) => {
      if (i === 3) return { attrs: { big: 'x'.repeat(9000) } };
      if (i === 240) return { status: 'error', attrs: { error: null } };
      if (i === 250) return { status: 'error', attrs: { error: { code: 'E_LATE' } } };
      return {};
    });
    ingestBatch(base, [rootEnd('t1'), ...rows]);
    rec.calls.length = 0;
    worker.notifyRootsEnded(['t1']);
    await worker.idle();
    const dry = await worker.runOnce(rule, 't1');
    expect(dry).toEqual({ value: 1, comment: null });

    expect(runs).toHaveLength(2);
    for (const trace of runs) {
      const observations = trace.observations as Array<{ obs_id: string; attrs: unknown }>;
      expect(observations).toHaveLength(200);
      expect(observations[0].obs_id).toBe('t1-root');
      expect(observations[4]).toMatchObject({ obs_id: 't1-c3', attrs: { truncated: true } });
      expect(observations[5].attrs).toEqual({ step: 4, note: 'n'.repeat(200) });
      expect(trace).toMatchObject({ trace_id: 't1', agent_id: 'support', status: 'ok', input: 'hi', output: 'hello' });
      expect(trace.error_message).toBe('{"code":"E_LATE"}');
    }
    // The dedupe check reads at most one score; the trace's scores are never loaded.
    const scoreReads = rec.calls.filter((c) => /FROM scores/.test(c.sql));
    expect(scoreReads.map((c) => c.args.at(-1))).toEqual([1]);
    expect(rec.calls.filter((c) => /FROM observations/.test(c.sql) && !/LIMIT/.test(c.sql))).toEqual([]);
  });

  it("evaluatorTraceFrom (Studio's judge dry run) builds the same trace from the full detail", async () => {
    const h = harness();
    const rule = createEvaluatorRule(h.db, codeRule({ enabled: false }));
    if (rule === undefined) throw new Error('rule not created');
    const rows = children('t1', 230, (i) => {
      if (i === 3) return { attrs: { big: 'x'.repeat(9000) } };
      if (i === 220) return { status: 'error', attrs: { error: 'late' } };
      return {};
    });
    ingestBatch(h.db, [rootEnd('t1'), ...rows]);
    await h.worker.runOnce(rule, 't1');
    const detail = traceDetail(h.db, 't1');
    expect(evaluatorTraceFrom('t1', detail?.observations ?? [])).toEqual(h.runs[0].trace);
    expect(h.runs[0].trace).toMatchObject({ error_message: 'late' });
  });

  it('a judge job claims with the root fields and the error, but no observation rows', async () => {
    const h = harness();
    createEvaluatorRule(h.db, judgeRule());
    await ingestAndWait(h, [rootEnd('t1'), ...children('t1', 210, (i) => (i === 205 ? { status: 'error', attrs: { error: 'late' } } : {}))]);
    const [job] = h.worker.claimJudgeJobs(1, 60_000);
    expect(job.trace).toEqual({
      trace_id: 't1',
      agent_id: 'support',
      name: 'invoke_agent refund-bot',
      status: 'ok',
      start: T0,
      end: T0 + 250,
      duration_ms: 250,
      input: 'hi',
      output: 'hello',
      error_message: 'late',
      observations: [],
    });
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
