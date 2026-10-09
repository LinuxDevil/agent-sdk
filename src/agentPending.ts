/**
 * Eve DUR-F15: `agent.pending()` - the runs a crash (or a pause) left
 * unfinished in the agent's checkpoint store, across all sessions, so an
 * operator can find and resume them after a restart.
 */

import type { ApprovalKind } from './execution/ApprovalGate';
import type { CheckpointError, CheckpointStore } from './execution/checkpoint';
import { ConfigurationError } from './execution/errors';

/** One unfinished run listed by `agent.pending()`. */
export interface PendingRun {
  /**
   * What to pass to `agent.resume()` to finish it: the `agent.session()` id
   * for a session turn, else the `sessionId` of the `send(msg, { sessionId })`
   * run (or of a fork).
   */
  sessionId: string;
  /** `'session'` for an `agent.session()` turn (checkpointed as `<id>.turn-<n>`), `'run'` for a `send(msg, { sessionId })` run. */
  kind: 'session' | 'run';
  /** The id the checkpoint is saved under in `store.checkpoints`. */
  checkpointId: string;
  /**
   * `'in-progress'`: interrupted (a crash, an abort) - or still running in
   * some process; `agent.resume(sessionId)` finishes it. `'awaiting-approval'`:
   * paused on `approvalId`; decide it with `agent.approvals.resolve()`.
   */
  status: 'in-progress' | 'awaiting-approval';
  /** With `status: 'awaiting-approval'`, the pending approval's id (`agent.approvals.get(approvalId)` shows the call). */
  approvalId?: string;
  /** `'question'` when the pause is an `ask_question` call. */
  approvalKind?: ApprovalKind;
  /** The checkpoint's `stepIndex`: how far the run got. */
  step: number;
  /** Why the last attempt at a session turn failed, when it did (`retryable: false`: fix the cause before resuming, or `discardPending()` the turn). */
  lastError?: CheckpointError;
}

const SESSION_TURN = /^(.+)\.turn-\d+$/;
/** The session's pointer to its paused turn (`pausedTurnKey()`): not a run of its own. */
const PAUSED_POINTER = /\.paused$/;

/**
 * The unfinished runs in `checkpoints`, by checkpoint id. Throws
 * `LOUSHO_CONFIG_MISSING_CHECKPOINT_STORE` without a store, and a
 * `ConfigurationError` when the store cannot `list()`.
 */
export async function listPendingRuns(checkpoints: CheckpointStore | undefined): Promise<PendingRun[]> {
  if (!checkpoints) {
    throw new ConfigurationError(
      'agent.pending() needs a checkpoint store: pass createAgent({ store }) with `checkpoints` (fileStore(), SqliteStore, ...).',
      'store',
      'LOUSHO_CONFIG_MISSING_CHECKPOINT_STORE'
    );
  }
  if (!checkpoints.list) {
    throw new ConfigurationError(
      "agent.pending() needs a checkpoint store that implements list(); the built-in file, SQLite, KV and memory stores do.",
      'store.checkpoints'
    );
  }
  const entries = await checkpoints.list({ status: ['in-progress', 'awaiting-approval'] });
  const runs: PendingRun[] = [];
  for (const { sessionId: checkpointId, status, checkpoint } of entries) {
    if (status === 'finished' || PAUSED_POINTER.test(checkpointId)) continue;
    const turn = SESSION_TURN.exec(checkpointId);
    runs.push({
      sessionId: turn ? turn[1] : checkpointId,
      kind: turn ? 'session' : 'run',
      checkpointId,
      status,
      ...(checkpoint.approvalId !== undefined && status === 'awaiting-approval' && { approvalId: checkpoint.approvalId }),
      ...(checkpoint.approvalKind !== undefined && status === 'awaiting-approval' && { approvalKind: checkpoint.approvalKind }),
      step: checkpoint.stepIndex,
      ...(checkpoint.lastError && { lastError: checkpoint.lastError }),
    });
  }
  return runs;
}
