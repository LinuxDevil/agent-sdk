/**
 * The trace object an online evaluator receives, built from a trace's
 * observation rows (`GET /api/v1/traces/:id`'s `observations`). The daemon's
 * worker builds it for code rules and for the judge jobs it hands out; Agent
 * Forge builds the same object from the trace detail for a judge dry run, so
 * both sides share this one function. Pure: no node builtins, no db.
 */

import type { ObservationRow } from './store';

/** Most observations handed to an evaluator (the oldest are kept). */
const MAX_OBSERVATIONS = 200;

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
  /** The first 200 observations by start. */
  observations: ObservationRow[];
}

function errorMessageOf(observations: readonly ObservationRow[]): string | null {
  const failed = observations.find((o) => o.status === 'error' && o.attrs?.error !== undefined && o.attrs.error !== null);
  if (failed === undefined) return null;
  const error = failed.attrs?.error;
  return typeof error === 'string' ? error : JSON.stringify(error);
}

/**
 * The evaluator's view of one trace from its observation rows (ordered by
 * start, as the trace detail returns them), or `undefined` when no row is a
 * root (`parent_obs_id === null`).
 */
export function evaluatorTraceFrom(traceId: string, observations: readonly ObservationRow[]): EvaluatorTrace | undefined {
  const root = observations.find((o) => o.parent_obs_id === null);
  if (root === undefined) return undefined;
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
    error_message: errorMessageOf(observations),
    observations: observations.slice(0, MAX_OBSERVATIONS),
  };
}
