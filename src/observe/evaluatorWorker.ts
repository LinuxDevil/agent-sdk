/**
 * Online evaluators, the running half: when a trace's root observation ends,
 * every enabled rule whose `filter` matches (and whose `sample_rate` draw
 * passes) scores the trace once, as a `source: 'online'` score named after
 * the rule.
 *
 * - Ingest only hands over trace ids ({@link EvaluatorWorker.notifyRootsEnded}):
 *   synchronous, O(batch), never throws. Rule matching, trace loading and the
 *   sandbox runs happen later, off the request, one trace per event-loop turn
 *   (the drain yields with `setImmediate` between traces).
 * - Rules match against the trace's root row alone; only a surviving `code`
 *   rule loads observation rows (the first 200, long attrs capped; never the
 *   trace's scores). Judge jobs carry the root fields and no observations.
 * - The pending queue is in memory and bounded (`maxQueue`, default 1000);
 *   past it a trace drops and counts in `stats().dropped`. Pending traces are
 *   lost on a daemon restart.
 * - `code` rules run their `config.source` as `(source)(trace)` in
 *   `sandbox({ driver: 'isolate', timeoutMs: 2000 })`. Without a loadable
 *   `isolated-vm` (or on Node >= 20 without `--no-node-snapshot`) they are
 *   skipped with one warning per worker.
 * - `judge` rules do not run here (the daemon holds no provider keys): a
 *   match queues a judge job (judgeJobs.ts, bounded at 500) that Agent Forge
 *   claims, runs with its stored keys, and answers with a result, which the
 *   worker writes as the same `online` score.
 */

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { createRequire } from 'node:module';

import { sandbox as realSandbox, sandboxErrorKind, type Sandbox, type SandboxOptions } from '../sandbox';
import type { SqlDatabase } from '../storage/sqlite/driver';
import { moduleDir } from '../utils/moduleDir';
import type { IngestEvent } from './envelope';
import { getEvaluatorRule, listEvaluatorRules, type EvaluatorRuleFilter, type EvaluatorRuleRow } from './evaluators';
import { EVALUATOR_ATTRS_CAP, EVALUATOR_MAX_OBSERVATIONS, errorMessageText, evaluatorTraceOf, type EvaluatorTrace } from './evaluatorTrace';
import { createJudgeJobs, type ClaimedJudgeJob, type JudgeJobStats, type JudgeScore } from './judgeJobs';
import {
  firstObservationError,
  firstObservations,
  ingestBatch,
  listScores,
  traceRootFields,
  type ObservationRootFields,
} from './store';

/** What one evaluator run produced: the score's value and comment. */
export interface EvaluatorResult {
  value: number | null;
  comment: string | null;
}

/** The worker's counters since it started. */
export interface EvaluatorWorkerStats {
  /** Traces waiting to be evaluated. */
  queued: number;
  /** Traces dropped because the queue was full. */
  dropped: number;
  /** Rule runs that wrote a score. */
  ran: number;
  /** Rule runs skipped because no runner could take them (no isolate). */
  skipped: number;
  /** Judge jobs waiting for Agent Forge to claim them. */
  judge_queued: number;
  /** Judge jobs claimed and not yet answered (lease running). */
  judge_leased: number;
  /** Judge jobs dropped because the judge queue (500) was full. */
  judge_dropped: number;
  /** Judge jobs discarded at claim time (rule deleted, disabled or no longer `judge`; trace gone). */
  judge_discarded: number;
  /** Judge results written as scores. */
  judge_scored: number;
}

/** Options of {@link startEvaluatorWorker}; every one is a test seam with a production default. */
export interface EvaluatorWorkerOptions {
  /** Builds the box a code rule runs in; default the SDK's `sandbox`. */
  sandbox?: (options: SandboxOptions) => Sandbox;
  /** The sampling draw in `[0, 1)`; default `Math.random`. */
  random?: () => number;
  /** Where warnings go; default `console.warn`. */
  warn?: (message: string) => void;
  /** Most traces waiting at once; default 1000. */
  maxQueue?: number;
  /** Whether the isolate driver can run here; default a cached probe for `isolated-vm`. */
  isolateAvailable?: () => boolean;
  /** Most judge jobs pending + leased at once; default 500. */
  maxJudgeJobs?: number;
  /** The clock judge-job leases run on; default `Date.now`. */
  now?: () => number;
}

/** The running worker the daemon owns. */
export interface EvaluatorWorker {
  /** Queue these traces (their root ended). Synchronous, never throws, never waits. */
  notifyRootsEnded(traceIds: readonly string[]): void;
  /**
   * Run `rule` on `traceId` once, ignoring `enabled`, `filter` and
   * `sample_rate`; writes nothing. `undefined` when the trace has no root
   * observation (or does not exist). Dry runs are serialized: a second call
   * waits for the one in flight, so parallel calls never run parallel isolates.
   */
  runOnce(rule: EvaluatorRuleRow, traceId: string): Promise<EvaluatorResult | undefined>;
  /** Resolves once the queue is empty and nothing is running. */
  idle(): Promise<void>;
  stats(): EvaluatorWorkerStats;
  /** Lease up to `max` judge jobs for `leaseMs` (expired leases requeue first; stale jobs are discarded). */
  claimJudgeJobs(max: number, leaseMs: number): ClaimedJudgeJob[];
  /** Write a claimed judge job's result as its score; the score id, or `undefined` for an unknown or expired job. */
  completeJudgeJob(jobId: string, result: EvaluatorResult): string | undefined;
  /** Drop the queue and stop taking traces; an in-flight run writes nothing. */
  stop(): void;
}

/** The default bound on traces waiting to be evaluated. */
const EVALUATOR_QUEUE_DEFAULT = 1000;

/** A code rule's wall-clock cap. */
const CODE_TIMEOUT_MS = 2000;
const MAX_COMMENT = 1000;
const RULES_PAGE = 1000;

const ISOLATE_WARNING =
  "[lousho observe] code evaluators are skipped: the 'isolate' sandbox needs the optional isolated-vm package " +
  '(npm install isolated-vm) and, on Node >= 20, NODE_OPTIONS=--no-node-snapshot.';

/**
 * Whether `isolated-vm` resolves beside the SDK and this process can load it
 * (Node >= 20 crashes on load without `--no-node-snapshot`). Resolving does
 * not load the native module.
 */
function probeIsolate(): boolean {
  const needsFlag = Number(process.versions.node.split('.')[0]) >= 20;
  const hasFlag = `${process.env.NODE_OPTIONS ?? ''} ${process.execArgv.join(' ')}`.includes('--no-node-snapshot');
  if (needsFlag && !hasFlag) return false;
  try {
    createRequire(path.join(moduleDir(), 'noop.js')).resolve('isolated-vm');
    return true;
  } catch {
    return false;
  }
}

let isolateProbe: boolean | undefined;
const defaultIsolateAvailable = (): boolean => (isolateProbe ??= probeIsolate());

/** The trace a code rule receives from its root's fields: the first 200 rows (attrs capped) and the error, no scores. */
function codeTrace(db: SqlDatabase, traceId: string, root: ObservationRootFields): EvaluatorTrace {
  const observations = firstObservations(db, traceId, EVALUATOR_MAX_OBSERVATIONS, EVALUATOR_ATTRS_CAP);
  return evaluatorTraceOf(traceId, root, errorMessageText(firstObservationError(db, traceId)), observations);
}

/** The trace a judge job carries: the root's fields and the error, no observations. */
function judgeTrace(db: SqlDatabase, traceId: string): EvaluatorTrace | undefined {
  const root = traceRootFields(db, traceId);
  return root === undefined ? undefined : evaluatorTraceOf(traceId, root, errorMessageText(firstObservationError(db, traceId)), []);
}

/** Whether every key the filter sets matches the trace's root. */
function matchesFilter(filter: EvaluatorRuleFilter, root: ObservationRootFields): boolean {
  if (filter.agent_id !== undefined && root.agent_id !== filter.agent_id) return false;
  if (filter.status !== undefined && root.status !== filter.status) return false;
  if (filter.name_contains !== undefined && !(root.name ?? '').includes(filter.name_contains)) return false;
  return true;
}

/** One event-loop turn: the drain awaits this between traces. */
const nextTurn = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

/** An evaluator's return value as a score: a finite number, or `{ value: number | null, comment? }`. */
export function toEvaluatorResult(raw: unknown): EvaluatorResult {
  if (typeof raw === 'number') return Number.isFinite(raw) ? { value: raw, comment: null } : invalidResult();
  if (raw === null || typeof raw !== 'object' || !('value' in raw)) return invalidResult();
  const { value, comment } = raw as { value: unknown; comment?: unknown };
  if (value !== null && !(typeof value === 'number' && Number.isFinite(value))) return invalidResult();
  return { value, comment: comment === undefined || comment === null ? null : String(comment).slice(0, MAX_COMMENT) };
}

const invalidResult = (): EvaluatorResult => ({ value: null, comment: 'invalid_result' });

/** The trace ids of root observations this batch ended, each once. */
export function rootsEndedIn(batch: readonly IngestEvent[]): string[] {
  const ids = new Set<string>();
  for (const event of batch) {
    if (event.type === 'observation' && event.data.parent_obs_id === undefined && event.data.end !== undefined) {
      ids.add(event.data.trace_id);
    }
  }
  return [...ids];
}

/** The judge queue's counters under their `judge_` stats names. */
const judgeStats = (stats: JudgeJobStats): Pick<EvaluatorWorkerStats, `judge_${keyof JudgeJobStats}`> => ({
  judge_queued: stats.queued,
  judge_leased: stats.leased,
  judge_dropped: stats.dropped,
  judge_discarded: stats.discarded,
  judge_scored: stats.scored,
});

/** Start the worker over `db`. */
export function startEvaluatorWorker(db: SqlDatabase, opts: EvaluatorWorkerOptions = {}): EvaluatorWorker {
  const makeSandbox = opts.sandbox ?? realSandbox;
  const random = opts.random ?? Math.random;
  const warn = opts.warn ?? ((message: string) => console.warn(message));
  const maxQueue = opts.maxQueue ?? EVALUATOR_QUEUE_DEFAULT;
  const isolateAvailable = opts.isolateAvailable ?? defaultIsolateAvailable;
  const counts = { dropped: 0, ran: 0, skipped: 0 };
  const pending: string[] = [];
  let stopped = false;
  let warned = false;
  let draining: Promise<void> | undefined;
  /** The tail of the dry-run lane: `runOnce` calls run one after another. */
  let dryRuns: Promise<unknown> = Promise.resolve();

  const runCode = async (rule: EvaluatorRuleRow, trace: EvaluatorTrace): Promise<EvaluatorResult> => {
    if (rule.kind !== 'code') return { value: null, comment: 'unsupported_kind' };
    try {
      const box = makeSandbox({ driver: 'isolate', timeoutMs: CODE_TIMEOUT_MS });
      return toEvaluatorResult(await box.run(rule.config.source, { args: [trace] }));
    } catch (error) {
      return { value: null, comment: sandboxErrorKind(error) ?? 'driver' };
    }
  };

  const alreadyScored = (rule: EvaluatorRuleRow, traceId: string): boolean =>
    listScores(db, { trace_id: traceId, name: rule.name, source: 'online', limit: 1 }).scores.length > 0;

  const writeScore = (score: JudgeScore): string => {
    const score_id = randomUUID();
    ingestBatch(db, [
      {
        type: 'score',
        data: {
          score_id,
          trace_id: score.trace_id,
          name: score.rule_name,
          value: score.value ?? undefined,
          source: 'online',
          comment: score.comment ?? undefined,
          agent_id: score.agent_id ?? undefined,
        },
      },
    ]);
    return score_id;
  };

  const judgeJobs = createJudgeJobs({
    getRule: (ruleId) => getEvaluatorRule(db, ruleId),
    loadTrace: (traceId) => judgeTrace(db, traceId),
    writeScore,
    now: opts.now,
    maxJobs: opts.maxJudgeJobs,
  });

  const skipCode = (): void => {
    counts.skipped++;
    if (warned) return;
    warned = true;
    warn(ISOLATE_WARNING);
  };

  /** Whether `rule` scores this trace now: filter and sample pass, not scored yet, no judge job for it. */
  const wants = (rule: EvaluatorRuleRow, traceId: string, root: ObservationRootFields): boolean =>
    matchesFilter(rule.filter, root) &&
    random() < rule.sample_rate &&
    !alreadyScored(rule, traceId) &&
    !judgeJobs.has(rule.rule_id, traceId);

  /** `trace()` builds the code rule's trace on first use, so judge-only and filtered-out traces load no rows. */
  const evaluateRule = async (
    rule: EvaluatorRuleRow,
    traceId: string,
    root: ObservationRootFields,
    trace: () => EvaluatorTrace
  ): Promise<void> => {
    if (!wants(rule, traceId, root)) return;
    // The daemon cannot run a judge: Agent Forge claims the job (judgeJobs.ts).
    if (rule.kind === 'judge') return void judgeJobs.enqueue(rule.rule_id, traceId);
    if (!isolateAvailable()) return skipCode();
    const result = await runCode(rule, trace());
    if (stopped) return;
    writeScore({ rule_name: rule.name, trace_id: traceId, agent_id: root.agent_id, ...result });
    counts.ran++;
  };

  const evaluateTrace = async (traceId: string): Promise<void> => {
    const rules = listEvaluatorRules(db, { limit: RULES_PAGE, offset: 0, enabled: true }).evaluators;
    if (rules.length === 0) return;
    const root = traceRootFields(db, traceId);
    if (root === undefined) return;
    let built: EvaluatorTrace | undefined;
    const trace = (): EvaluatorTrace => (built ??= codeTrace(db, traceId, root));
    for (const rule of rules) {
      if (stopped) return;
      await evaluateRule(rule, traceId, root, trace);
    }
  };

  const drain = async (): Promise<void> => {
    for (;;) {
      await nextTurn();
      if (stopped || pending.length === 0) return;
      const traceId = pending.shift() as string;
      try {
        await evaluateTrace(traceId);
      } catch (error) {
        if (!stopped) warn(`[lousho observe] evaluating trace '${traceId}' failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  const schedule = (): void => {
    if (draining !== undefined || stopped) return;
    draining = drain().finally(() => {
      draining = undefined;
      if (pending.length > 0) schedule();
    });
  };

  return {
    notifyRootsEnded(traceIds) {
      if (stopped) return;
      for (const traceId of traceIds) {
        if (pending.length >= maxQueue) counts.dropped++;
        else pending.push(traceId);
      }
      schedule();
    },
    runOnce(rule, traceId) {
      const run = dryRuns.then(async (): Promise<EvaluatorResult | undefined> => {
        const root = traceRootFields(db, traceId);
        if (root === undefined) return undefined;
        if (rule.kind !== 'code') return { value: null, comment: 'unsupported_kind' };
        if (!isolateAvailable()) return { value: null, comment: 'isolate_unavailable' };
        return runCode(rule, codeTrace(db, traceId, root));
      });
      dryRuns = run.catch(() => undefined);
      return run;
    },
    async idle() {
      while (draining !== undefined) await draining;
    },
    stats: () => ({ queued: pending.length, ...counts, ...judgeStats(judgeJobs.stats()) }),
    claimJudgeJobs: (max, leaseMs) => (stopped ? [] : judgeJobs.claim(max, leaseMs)),
    completeJudgeJob: (jobId, result) => (stopped ? undefined : judgeJobs.complete(jobId, result)),
    stop() {
      stopped = true;
      pending.length = 0;
      judgeJobs.clear();
    },
  };
}
