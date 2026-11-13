import type { Checkpoint } from '../execution/checkpoint';
import type { GoalIteration, GoalRunResult, GoalUsage } from './runGoal';

/** A goal run's progress, saved in a checkpoint's `businessState.goalRun` after every iteration. */
export interface GoalProgress {
  /** The last finished iteration, from 1 (0 before the first). */
  iteration: number;
  /** Every finished iteration, in order. */
  iterations: GoalIteration[];
  /** Usage so far. */
  usage: GoalUsage;
  /** The best check score so far, or -1. */
  best: number;
  /** Iterations in a row without a better score. */
  flat: number;
  /** Milliseconds the loop has run, summed over every attempt. */
  elapsedMs: number;
  /** The step index the next iteration takes. */
  nextStepIndex: number;
  /** The final result, once the run ended. */
  finished?: GoalRunResult;
}

/** Where goal checkpoints go: any checkpoint store, such as the host's workspace checkpoint store (P1.18). */
export interface GoalCheckpointStore {
  /** Saves the latest checkpoint of a run. */
  save(runId: string, checkpoint: Checkpoint): Promise<void>;
  /** The latest checkpoint of a run, or `null`. */
  load(runId: string): Promise<Checkpoint | null>;
}

const AGENT_ID = 'lousho.goal';

export function toCheckpoint(runId: string, progress: GoalProgress, status: 'in-progress' | 'finished'): Checkpoint {
  return {
    agentId: AGENT_ID,
    sessionId: runId,
    stepIndex: progress.iteration,
    messages: [],
    toolCalls: [],
    usage: { promptTokens: progress.usage.inputTokens, completionTokens: progress.usage.outputTokens, totalTokens: progress.usage.totalTokens },
    status,
    businessState: { goalRun: progress },
  };
}

function isProgress(value: unknown): value is GoalProgress {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<GoalProgress>;
  return typeof v.iteration === 'number' && Array.isArray(v.iterations) && typeof v.nextStepIndex === 'number' && typeof v.elapsedMs === 'number';
}

export function progressOf(checkpoint: Checkpoint): GoalProgress | undefined {
  const state = checkpoint.businessState as { goalRun?: unknown } | null | undefined;
  return checkpoint.agentId === AGENT_ID && isProgress(state?.goalRun) ? state.goalRun : undefined;
}
