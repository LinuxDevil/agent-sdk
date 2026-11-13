/**
 * The eval gate's shared value types. `CandidateRun` is what one dataset
 * example's run on the candidate spec produced; `EvalGateDeps` and the
 * result interfaces live in gateRunner.ts (the ticket contract puts them
 * there) - this file exists so gateChecks.ts and judgeGate.ts can name
 * `CandidateRun` without a runtime import cycle back into the runner.
 */

/** What one example run on the candidate spec produced. */
export interface CandidateRun {
  text: string;
  /** `result.toolCalls.map(c => c.name)` equivalents, in call order. */
  toolNames: string[];
  /** `result.usage.costUsd ?? null`. */
  costUsd: number | null;
  /** `result.steps`. */
  steps: number;
  /** Trace id of the example run when the observe reporter produced one. */
  traceId?: string;
  /** Set when the run threw or `finishReason === 'error'`. */
  error?: string;
}
