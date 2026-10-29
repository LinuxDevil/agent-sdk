/**
 * The trace object an online evaluator receives. The daemon's worker builds
 * it from bounded queries (the root row, the first 200 rows, the first error
 * row; store.ts) for code rules, and from the root row alone for the judge
 * jobs it hands out; Agent Forge builds the same object from the trace
 * detail's rows for a judge dry run ({@link evaluatorTraceFrom}). Both paths
 * share the error and attrs rules here. Pure: no node builtins, no db.
 */

import type { ObservationRootFields, ObservationRow } from './store';

/** Most observations handed to an evaluator (the oldest are kept). */
export const EVALUATOR_MAX_OBSERVATIONS = 200;

/** Longest `attrs` JSON text (characters) an evaluator's observation keeps; a longer one becomes `{ truncated: true }`. */
export const EVALUATOR_ATTRS_CAP = 8192;

/** What an online evaluator receives: the root observation's fields plus the trace's first observations. */
export interface EvaluatorTrace {
  /** The trace id. */
  trace_id: string;
  /** The root's agent. */
  agent_id: string | null;
  /** The root's name. */
  name: string | null;
  /** The root's status. */
  status: string | null;
  /** The root's start, epoch ms. */
  start: number;
  /** The root's end, epoch ms. */
  end: number | null;
  /** `end - start`, or `null` while open. */
  duration_ms: number | null;
  /** The root's captured input. */
  input: string | null;
  /** The root's captured output. */
  output: string | null;
  /** The first error observation's `attrs.error`, stringified when it is not a string. */
  error_message: string | null;
  /**
   * The first 200 observations by start. A row whose `attrs` JSON text is
   * longer than 8192 characters carries `attrs: { truncated: true }` instead.
   * Judge jobs (`POST /api/v1/evaluators/judge-jobs/claim`) carry none: `[]`.
   */
  observations: ObservationRow[];
}

/** An `attrs.error` value as `error_message`: `null` when absent, a string as is, anything else as JSON. */
export function errorMessageText(error: unknown): string | null {
  if (error === undefined || error === null) return null;
  return typeof error === 'string' ? error : JSON.stringify(error);
}

/** The first error row's `attrs.error`, the same rule the daemon's error query applies. */
function errorMessageOf(observations: readonly ObservationRow[]): string | null {
  const failed = observations.find((o) => o.status === 'error' && o.attrs?.error !== undefined && o.attrs.error !== null);
  return errorMessageText(failed?.attrs?.error);
}

/** `row` with its attrs replaced by `{ truncated: true }` when their JSON text passes {@link EVALUATOR_ATTRS_CAP}. */
function capAttrs(row: ObservationRow): ObservationRow {
  if (row.attrs === null || JSON.stringify(row.attrs).length <= EVALUATOR_ATTRS_CAP) return row;
  return { ...row, attrs: { truncated: true } };
}

/** The evaluator trace from its root's fields, its error message and its (already bounded) observations. */
export function evaluatorTraceOf(
  traceId: string,
  root: ObservationRootFields,
  errorMessage: string | null,
  observations: ObservationRow[]
): EvaluatorTrace {
  return {
    trace_id: traceId,
    agent_id: root.agent_id,
    name: root.name,
    status: root.status,
    start: root.start,
    end: root.end,
    duration_ms: root.end === null ? null : root.end - root.start,
    input: root.input,
    output: root.output,
    error_message: errorMessage,
    observations,
  };
}

/**
 * The evaluator's view of one trace from its observation rows (ordered by
 * start, as the trace detail returns them), or `undefined` when no row is a
 * root (`parent_obs_id === null`).
 */
export function evaluatorTraceFrom(traceId: string, observations: readonly ObservationRow[]): EvaluatorTrace | undefined {
  const root = observations.find((o) => o.parent_obs_id === null);
  if (root === undefined) return undefined;
  return evaluatorTraceOf(traceId, root, errorMessageOf(observations), observations.slice(0, EVALUATOR_MAX_OBSERVATIONS).map(capAttrs));
}
