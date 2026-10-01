/**
 * Checkpoint
 * Backend-agnostic durable-execution checkpointing for AgentExecutor runs.
 */

import { Message } from '../providers';
import { StorageService } from '../storage';
import type { StepUsage } from '../models/usage';
import type { CheckpointUsage } from './runUsage';

/**
 * Where the run recorded in a {@link Checkpoint} stands (LOU-U8):
 *
 * - `'in-progress'`: the run has not finished (it crashed, was aborted, or
 *   is still running). `execute()` with the same `sessionId` resumes it.
 * - `'awaiting-approval'`: paused on a tool call that needs a human
 *   decision. `execute()` with the same `sessionId` throws
 *   `SessionAwaitingApprovalError`; call `resumeAfterApproval()` instead.
 * - `'finished'`: the run ended normally. `execute()` with the same
 *   `sessionId` continues the conversation: the new input becomes the next
 *   user turn after the stored messages.
 */
export type CheckpointStatus = 'in-progress' | 'awaiting-approval' | 'finished';

/**
 * A snapshot of an agent run, saved after each model response, after each
 * tool result and when the run pauses or finishes, so execution can resume
 * from here (e.g. after a process restart).
 */
export interface Checkpoint {
  agentId: string;
  sessionId: string;
  stepIndex: number;
  messages: Message[];
  toolCalls: unknown[];
  /**
   * Running usage of the run so far (LOU-V5). A resumed run continues from
   * these totals. Checkpoints written before LOU-V5 hold only the three
   * token counts and still load (their tokens are kept, cost is unknown).
   */
  usage: CheckpointUsage;
  /** Per-call usage so far (LOU-V5); absent on older checkpoints. */
  stepUsage?: StepUsage[];
  finishReason?: string;
  /**
   * LOU-T1: opaque, consumer-owned business/domain state co-located with
   * execution state on the same checkpoint record (an order id, a ticket
   * id, a workflow stage - whatever a caller's application needs to stay
   * aligned with this run across a crash or an approval pause/resume
   * cycle).
   *
   * This is pure co-location, not validation: the SDK never reads,
   * interprets, mutates, or acts on this value - it is stored and returned
   * exactly as given, the same as any other JSON-serializable blob passed
   * through a store. It must be JSON-serializable, since concrete
   * `CheckpointStore` implementations may round-trip it through
   * `JSON.stringify`/`JSON.parse` (see `LocalStorageCheckpointStore` and
   * `apps/agent-forge/server/checkpointStore.ts`'s `FileCheckpointStore`).
   * A consumer relying on this field for anything security- or
   * correctness-critical should treat it exactly like any other
   * unvalidated input they control both ends of - the SDK provides no
   * integrity or schema guarantees on its contents.
   *
   * Set via `ExecuteOptions.businessState` (src/execution/AgentExecutor.ts);
   * carried forward across an approval pause/resume by
   * `resumeAfterApproval()` (src/execution/resume.ts) unless the caller's
   * `ResumeExecuteOptions.businessState` explicitly overrides it.
   *
   * Known limitation: because the carry-forward check is `=== undefined`,
   * an `undefined` `businessState` option is indistinguishable from
   * omitting the option entirely - both mean "inherit whatever the loaded
   * checkpoint already has". There is currently no way to explicitly
   * *clear* a previously-attached businessState back to `undefined` on a
   * rehydrated/resumed run. A caller that needs to intentionally blank it
   * out can pass `businessState: null` instead - `null !== undefined`, so
   * it is treated as an explicit override (stored as `null`) rather than
   * "inherit".
   */
  businessState?: unknown;
  /**
   * LOU-U8: where the run stands - see {@link CheckpointStatus}. Absent on
   * checkpoints written before this field existed, which are treated as
   * `'in-progress'` (the only kind that was ever kept).
   */
  status?: CheckpointStatus;
  /** LOU-U8: with `status: 'awaiting-approval'`, the id of the pending approval. */
  approvalId?: string;
}

/**
 * Storage-backend-agnostic interface for persisting/loading Checkpoints.
 */
export interface CheckpointStore {
  save(sessionId: string, checkpoint: Checkpoint): Promise<void>;
  load(sessionId: string): Promise<Checkpoint | null>;
  delete(sessionId: string): Promise<void>;
}

/**
 * Default CheckpointStore backed by the SDK's StorageService, keyed by
 * `checkpoints/{sessionId}.json`.
 */
export class LocalStorageCheckpointStore implements CheckpointStore {
  constructor(private readonly storageService: StorageService) {}

  private getStorageKey(sessionId: string): string {
    return `checkpoints/${sessionId}.json`;
  }

  async save(sessionId: string, checkpoint: Checkpoint): Promise<void> {
    const storageKey = this.getStorageKey(sessionId);
    await this.storageService.acquireLock(storageKey);
    try {
      this.storageService.writePlainJSONAttachment(storageKey, checkpoint);
    } finally {
      this.storageService.releaseLock(storageKey);
    }
  }

  async load(sessionId: string): Promise<Checkpoint | null> {
    const storageKey = this.getStorageKey(sessionId);
    await this.storageService.acquireLock(storageKey);
    try {
      if (!this.storageService.fileExists(storageKey)) {
        return null;
      }
      return this.storageService.readPlainJSONAttachment<Checkpoint>(storageKey);
    } finally {
      this.storageService.releaseLock(storageKey);
    }
  }

  async delete(sessionId: string): Promise<void> {
    const storageKey = this.getStorageKey(sessionId);
    // deleteAttachment already swallows "not found" (it no-ops if the file
    // doesn't exist), so no extra try/catch is needed here.
    this.storageService.deleteAttachment(storageKey);
  }
}
