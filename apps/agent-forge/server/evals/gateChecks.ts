/**
 * gateChecks: the deterministic eval gates - the checks a candidate run
 * answers without a model. Each returns `null` when the run passes and the
 * exact failure sentence the gate report shows when it does not (the
 * strings are the ticket contract, word for word). The model-graded `judge`
 * gate lives in judgeGate.ts; it is the one gate that is not in
 * {@link DETERMINISTIC_CHECKS}.
 */
import type { CandidateRun } from './types';

/** `calledTool`: the run must have called the named tool at least once. */
function checkCalledTool(gate: { calledTool: string }, run: CandidateRun): string | null {
  return run.toolNames.includes(gate.calledTool) ? null : `Did not call tool '${gate.calledTool}'`;
}

/** `notCalledTool`: the run must not have called the named tool. */
function checkNotCalledTool(gate: { notCalledTool: string }, run: CandidateRun): string | null {
  return run.toolNames.includes(gate.notCalledTool) ? `Called tool '${gate.notCalledTool}'` : null;
}

/** `maxCostUsd`: the run's cost must be known and within the limit. */
function checkMaxCost(gate: { maxCostUsd: number }, run: CandidateRun): string | null {
  if (run.costUsd === null) return `Cost unknown (model has no price), limit $${gate.maxCostUsd}`;
  return run.costUsd <= gate.maxCostUsd ? null : `Cost $${run.costUsd.toFixed(4)} is over $${gate.maxCostUsd}`;
}

/** `maxSteps`: the run's step count must be within the limit. */
function checkMaxSteps(gate: { maxSteps: number }, run: CandidateRun): string | null {
  return run.steps <= gate.maxSteps ? null : `Took ${run.steps} steps, limit ${gate.maxSteps}`;
}

/**
 * The deterministic gates by their single spec key (`calledTool`,
 * `notCalledTool`, `maxCostUsd`, `maxSteps` - `judge` is absent on
 * purpose). A lookup table rather than a switch keeps the dispatch flat.
 */
export const DETERMINISTIC_CHECKS: Record<string, (gate: never, run: CandidateRun) => string | null> = {
  calledTool: checkCalledTool as (gate: never, run: CandidateRun) => string | null,
  notCalledTool: checkNotCalledTool as (gate: never, run: CandidateRun) => string | null,
  maxCostUsd: checkMaxCost as (gate: never, run: CandidateRun) => string | null,
  maxSteps: checkMaxSteps as (gate: never, run: CandidateRun) => string | null,
};
