/**
 * Eval scores as observability data (spec: docs/specs/0001-observability-platform/0001-evaluators.md).
 *
 * When `LOUSHO_OBSERVE` is set (or `lousho eval --observe` set it inside the
 * vitest worker), each eval case runs inside an `eval <name>` span reported
 * to the same collector reporter the exercised agent uses, and the case's
 * assertions are queued as `score` ingest events on that reporter's outbox -
 * after the span, with its retry, buffer cap and exit and crash flushes. The span's id becomes the
 * `trace_id` of both the score rows and the exercised run's spans, so a
 * failing score reaches the run that produced it in one click - the eval
 * harness's own judgement context sits in the same trace as the root span.
 *
 * Emission lives here rather than in recorder.ts because it needs the span,
 * not just the result. Everything degrades silently: `LOUSHO_OBSERVE` unset
 * means no span and no POSTs, and a dead daemon is retried or counted as
 * dropped, never thrown into the eval (see src/observe/reporter.ts).
 */

import { createAgentConfigOf, type SimpleAgent } from '../createAgent';
import { withSpan } from '../execution/tracing';
import { observeTargetFromEnv } from '../observe/emit';
import { observeExporterFromEnv, queueObserveEvents, type ObserveReporter } from '../observe/reporter';
import type { IngestEvent } from '../observe/envelope';
import { newId } from '../utils/id';
import { gateFailures, type EvalResult } from './evalResult';
import { isRemoteTarget } from './remoteTarget';

/**
 * The name the scored agent reports under: its `createAgent({ name })` (or a
 * config's own `name`), defaulting to `'agent'` like createAgent does.
 * `undefined` when there is no scored agent to attribute - a remoteTarget()
 * (whose id lives on the deployment) or no agent at all.
 */
export function scoredAgentName(agent: unknown): string | undefined {
  if (agent === undefined || agent === null || isRemoteTarget(agent)) return undefined;
  const config = typeof agent === 'object' || typeof agent === 'function' ? createAgentConfigOf(agent as SimpleAgent) : undefined;
  if (config) return config.name || 'agent';
  const name = (agent as { name?: unknown }).name;
  return typeof name === 'string' && name ? name : 'agent';
}

/**
 * One `score` ingest event per `AssertionResult` plus a final eval-level row, the spec's mapping:
 * `name` is `<evalName>/<assertionName>`, llmJudge verdicts land with
 * `source: 'judge'`, everything else `'eval'`. `score_id` is fresh per
 * emission - a re-run is a new row, not an upsert, so eval history keeps
 * every attempt. The closing `<evalName>` row is 1 unless a gate assertion failed or the case
 * threw (else 0, commenting the failed gate names or the error); a result with no assertions emits nothing.
 */
export function scoreEventsOf(
  result: EvalResult,
  options: { traceId: string; agentId?: string; now?: () => number; newId?: () => string }
): IngestEvent[] {
  const ts = (options.now ?? Date.now)();
  const id = options.newId ?? newId;
  const rows: IngestEvent[] = result.assertions.map((assertion) => ({
    type: 'score' as const,
    data: {
      score_id: id(),
      trace_id: options.traceId,
      name: `${result.name}/${assertion.name}`,
      value: assertion.score,
      source: assertion.source ?? 'eval',
      ...(assertion.message !== undefined ? { comment: assertion.message } : {}),
      ...(options.agentId !== undefined ? { agent_id: options.agentId } : {}),
      ts,
    },
  }));
  if (result.assertions.length === 0) return rows;
  // The eval-level row follows the eval's own verdict: 1 unless a gate assertion failed or the case threw
  // (soft failures never fail an eval; they keep their own rows). The comment names the failed gates, or the error.
  // The case label rides on the eval span that owns this trace (`lousho.eval.case`); score events carry no attrs.
  const failed = gateFailures(result).map((assertion) => assertion.name);
  const comment = failed.length > 0 ? failed.join('; ') : result.error;
  rows.push({
    type: 'score',
    data: {
      score_id: id(),
      trace_id: options.traceId,
      name: result.name,
      value: comment === undefined ? 1 : 0,
      source: 'eval',
      ...(comment !== undefined ? { comment } : {}),
      ...(options.agentId !== undefined ? { agent_id: options.agentId } : {}),
      ts,
    },
  });
  return rows;
}

/** Whether eval cases emit score events and run inside an `eval` span (the same env check the emit path applies). */
export function evalObservationEnabled(env: NodeJS.ProcessEnv | undefined = typeof process !== 'undefined' ? process.env : undefined): boolean {
  return observeTargetFromEnv(env) !== undefined;
}

/** Cap on each per-case network wait (span flush, score flush): a down daemon must never slow or fail a case. */
const EVAL_FLUSH_TIMEOUT_MS = 1000;

/** How long cases skip the waits after a daemon did not answer in time - then the next case tries again. */
const UNRESPONSIVE_SKIP_MS = 30_000;

/**
 * Reporters whose daemon stopped answering in time, with when that skip ends.
 * Meanwhile cases do not wait on a flush; their spans and scores still queue
 * on the reporter and go out on its own retry cadence.
 */
const unresponsiveUntil = new WeakMap<ObserveReporter, number>();

/** Flush `reporter` for at most EVAL_FLUSH_TIMEOUT_MS, unless it is in a skip window; a flush that runs out starts one. */
async function boundedFlush(reporter: ObserveReporter, now: () => number): Promise<void> {
  if (now() < (unresponsiveUntil.get(reporter) ?? 0)) return;
  if (!(await within(reporter.flush(EVAL_FLUSH_TIMEOUT_MS), EVAL_FLUSH_TIMEOUT_MS))) {
    unresponsiveUntil.set(reporter, now() + UNRESPONSIVE_SKIP_MS);
  }
}

/** Resolves when `work` settles or after `ms`, whichever is first; `false` on the timeout. Never rejects. */
async function within(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true, () => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** One eval case's observation: the wrapper span to parent exercised runs under, and the score emit. */
export interface EvalCaseObservation {
  /**
   * Runs `work` inside the case's `eval <name>` span when observation is on
   * (`work` gets the span id to pass as `parentSpanId` to the exercised run,
   * putting it in the same trace); a plain `work(undefined)` call when off.
   */
  run<T>(work: (parentSpanId: string | undefined) => Promise<T>): Promise<T>;
  /** Queues the case's score events and flushes them (bounded); resolves, never rejects. A no-op when observation is off or the case recorded no assertions. */
  emit(result: EvalResult): Promise<void>;
}

/**
 * The observation context of one eval case. When `LOUSHO_OBSERVE` resolves a
 * target, `run` wraps the case in an `eval <evalName>` span on the scored
 * agent's own env reporter (same memoized instance -> the run's spans nest
 * into this trace); `emit` queues one `score` event per assertion on that
 * reporter, with the span's id as `trace_id` and the scored agent's `agent_id`.
 * Each wait for the daemon is capped at 1s; one that runs out skips the waits
 * of the cases in the next 30s.
 */
export function evalCaseObservation(options: {
  /** The eval's name (the score rows' `<evalName>/...` prefix). */
  evalName: string;
  /** The dataset case's label, recorded on the eval span. */
  caseLabel?: string;
  /** The scored agent (a SimpleAgent, a `{ name }` config, or an EvalTarget); resolved for its reporter name + `agent_id`. */
  agent?: unknown;
  /** A span to parent the eval span to (the classic eval's own `parentSpanId` passthrough). */
  parentSpanId?: string;
  /** Env override (tests); default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Clock for the unresponsive-daemon skip window (tests); default `Date.now`. */
  now?: () => number;
}): EvalCaseObservation {
  const now = options.now ?? Date.now;
  const env = options.env ?? (typeof process !== 'undefined' ? process.env : undefined);
  const scoredName = scoredAgentName(options.agent);
  // The scored agent's reporter is the memoized env reporter under the same
  // name - reporting the eval span to it puts the span and the exercised
  // run's spans in one trace (`parentSpanId` resolves through its map).
  // Without a scored agent (remote target) the harness reports as 'eval'.
  const reporter = observeTargetFromEnv(env) === undefined ? undefined : observeExporterFromEnv({ agentName: scoredName ?? 'eval', env });
  let traceId: string | undefined;
  return {
    async run<T>(work: (parentSpanId: string | undefined) => Promise<T>): Promise<T> {
      if (!reporter) return work(undefined);
      // The eval span ends into the reporter's batched outbox; a vitest worker
      // can exit before the interval flush, leaving the scores' trace_id dangling.
      try {
        return await withSpan(
          reporter,
          `eval ${options.evalName}`,
          {
            'lousho.eval.name': options.evalName,
            ...(options.caseLabel !== undefined ? { 'lousho.eval.case': options.caseLabel } : {}),
          },
          (span) => {
            traceId = span.id;
            return work(span.id);
          },
          options.parentSpanId
        );
      } finally {
        await boundedFlush(reporter, now);
      }
    },
    async emit(result: EvalResult): Promise<void> {
      if (!reporter || traceId === undefined || result.assertions.length === 0) return;
      // On the reporter's outbox the scores go out after the eval span and retry with it.
      queueObserveEvents(reporter, scoreEventsOf(result, { traceId, ...(scoredName !== undefined ? { agentId: reporter.agentId } : {}) }));
      await boundedFlush(reporter, now);
    },
  };
}
