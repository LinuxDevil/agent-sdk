/**
 * Eval scores as observability data (spec: docs/specs/0001-observability-platform/0001-evaluators.md).
 *
 * When `LOUSHO_OBSERVE` is set (or `lousho eval --observe` set it inside the
 * vitest worker), each eval case runs inside an `eval <name>` span reported
 * to the same collector reporter the exercised agent uses, and the case's
 * assertions POST as `score` ingest events. The span's id becomes the
 * `trace_id` of both the score rows and the exercised run's spans, so a
 * failing score reaches the run that produced it in one click - the eval
 * harness's own judgement context sits in the same trace as the root span.
 *
 * Emission lives here rather than in recorder.ts because it needs the span,
 * not just the result. Everything degrades silently: `LOUSHO_OBSERVE` unset
 * means no span and no POSTs, and a dead daemon is counted as dropped, never
 * thrown into the eval (see src/observe/emit.ts).
 */

import { createAgentConfigOf, type SimpleAgent } from '../createAgent';
import { withSpan } from '../execution/tracing';
import { emitObserveEvents, observeTargetFromEnv } from '../observe/emit';
import { observeExporterFromEnv } from '../observe/reporter';
import type { IngestEvent } from '../observe/envelope';
import { newId } from '../utils/id';
import type { EvalResult } from './evalResult';
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
 * One `score` ingest event per `AssertionResult`, the spec's mapping:
 * `name` is `<evalName>/<assertionName>`, llmJudge verdicts land with
 * `source: 'judge'`, everything else `'eval'`. `score_id` is fresh per
 * emission - a re-run is a new row, not an upsert, so eval history keeps
 * every attempt.
 */
export function scoreEventsOf(
  result: EvalResult,
  options: { traceId: string; agentId?: string; now?: () => number; newId?: () => string }
): IngestEvent[] {
  const ts = (options.now ?? Date.now)();
  const id = options.newId ?? newId;
  return result.assertions.map((assertion) => ({
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
}

/** Whether eval cases emit score events and run inside an `eval` span (the same env check the emit path applies). */
export function evalObservationEnabled(env: NodeJS.ProcessEnv | undefined = typeof process !== 'undefined' ? process.env : undefined): boolean {
  return observeTargetFromEnv(env) !== undefined;
}

/** One eval case's observation: the wrapper span to parent exercised runs under, and the score emit. */
export interface EvalCaseObservation {
  /**
   * Runs `work` inside the case's `eval <name>` span when observation is on
   * (`work` gets the span id to pass as `parentSpanId` to the exercised run,
   * putting it in the same trace); a plain `work(undefined)` call when off.
   */
  run<T>(work: (parentSpanId: string | undefined) => Promise<T>): Promise<T>;
  /** POSTs the case's score events (fire-and-forget); a no-op when observation is off or the case recorded no assertions. */
  emit(result: EvalResult): void;
}

/**
 * The observation context of one eval case. When `LOUSHO_OBSERVE` resolves a
 * target, `run` wraps the case in an `eval <evalName>` span on the scored
 * agent's own env reporter (same memoized instance -> the run's spans nest
 * into this trace); `emit` posts one `score` event per assertion with that
 * span's id as `trace_id` and the scored agent's `agent_id`.
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
}): EvalCaseObservation {
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
      return withSpan(
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
    },
    emit(result: EvalResult): void {
      if (!reporter || traceId === undefined || result.assertions.length === 0) return;
      const events = scoreEventsOf(result, { traceId, ...(scoredName !== undefined ? { agentId: reporter.agentId } : {}) });
      // Fire-and-forget: emitObserveEvents drops-and-counts, it never throws into the eval.
      void emitObserveEvents(events, { env });
    },
  };
}
