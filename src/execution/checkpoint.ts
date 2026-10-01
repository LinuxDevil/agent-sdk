/**
 * Checkpoint
 * Backend-agnostic durable-execution checkpointing for AgentExecutor runs.
 */

import { Message } from '../providers';
import { StorageService } from '../storage';
import type { StepUsage } from '../models/usage';
import type { CheckpointUsage } from './runUsage';
import type { AgentFingerprint } from './agentFingerprint';

/** Key of `AgentConfig.metadata` holding a dynamic run's `ctx` and model (LOU-V15): saved in approval snapshots and checkpoints. */
export const RUN_CONFIG_KEY = 'loushyRunConfig';

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
  /**
   * LOU-W9.2: the fingerprint of the agent that wrote this checkpoint. A
   * resume compares it with the resuming agent's (`onAgentDrift`). Absent on
   * older checkpoints, which resume without any check.
   */
  agentFingerprint?: AgentFingerprint;
  /**
   * LOU-V15.2: with `createAgent({ model | instructions | tools: fn })`, the
   * run's `ctx` and the model it chose, so a crash resume re-resolves the
   * agent the same way the run started. Opaque; absent for static agents.
   */
  runConfig?: unknown;
}

/**
 * One saved checkpoint in a session's history (LOU-D43).
 */
export interface CheckpointHistoryEntry {
  /** `checkpoint.stepIndex` at the time of the save. */
  step: number;
  /** When the store saved it, as an ISO 8601 timestamp. */
  savedAt: string;
  /** `checkpoint.status`, `'in-progress'` when the checkpoint has none. */
  status: CheckpointStatus;
  checkpoint: Checkpoint;
}

/** Options for {@link CheckpointStore.history}. */
export interface CheckpointHistoryOptions {
  /** Return at most this many entries (the newest). Default: all that are kept. */
  limit?: number;
}

/** Options for {@link CheckpointStore.delete}. */
export interface CheckpointDeleteOptions {
  /** Keep the session's history (default: delete it with the checkpoint). */
  keepHistory?: boolean;
}

/** Changes `AgentExecutor.fork()` applies to the forked checkpoint (LOU-D44), in this order. */
export interface ForkPatch {
  /** Rewrites the transcript (it gets a copy). */
  messages?: (messages: Message[]) => Message[];
  /** Replaces `businessState` (`null` clears it). */
  businessState?: unknown;
  /**
   * Replaces the result of the tool call `toolCallId` (the message keeps its
   * place, call id and tool name, so the transcript stays valid), or records
   * it when the call has no result yet. `result` is JSON-serialized, as tool
   * results are.
   */
  toolResult?: { toolCallId: string; result: unknown };
  /** Queues a user message, sent after any tool calls still pending. */
  appendInput?: string;
}

/** Options for `AgentExecutor.fork()` (LOU-D44). */
export interface ForkOptions {
  /** The session to fork; it is not changed. */
  sessionId: string;
  /** The step (`stepIndex`) to fork at; the newest history entry of that step is used. */
  fromStep: number;
  /** The fork's session id. Default: `<sessionId>.fork-<n>`, the first `n` with no checkpoint. */
  newSessionId?: string;
  /** A store that keeps a history (`history()`); the fork is saved in it too. */
  checkpointStore: CheckpointStore;
  patch?: ForkPatch;
}

/** A fork made by `AgentExecutor.fork()`: continue it with `execute({ sessionId, checkpointStore, input: [] })`. */
export interface ForkResult {
  sessionId: string;
  /** The step it was forked at. */
  step: number;
  /** The fork's current checkpoint (`status: 'in-progress'`). */
  checkpoint: Checkpoint;
}

/** How many checkpoints a store's history keeps per session unless told otherwise. */
export const DEFAULT_CHECKPOINT_HISTORY_LIMIT = 50;

/**
 * Storage-backend-agnostic interface for persisting/loading Checkpoints.
 *
 * `history` is optional (LOU-D43): a store that implements it also appends
 * every `save()` to a bounded per-session history (oldest dropped past the
 * store's `historyLimit`), and `delete()` clears that history unless called
 * with `{ keepHistory: true }`. Use {@link getCheckpointHistory} to read it
 * from a store that may not have it.
 */
export interface CheckpointStore {
  save(sessionId: string, checkpoint: Checkpoint): Promise<void>;
  load(sessionId: string): Promise<Checkpoint | null>;
  delete(sessionId: string, options?: CheckpointDeleteOptions): Promise<void>;
  /** Saved checkpoints of the session, newest first; `[]` when there are none. */
  history?(sessionId: string, options?: CheckpointHistoryOptions): Promise<CheckpointHistoryEntry[]>;
}

/**
 * The session's checkpoint history, or `undefined` when `store` does not keep
 * one (it has no `history()`).
 */
export async function getCheckpointHistory(
  store: CheckpointStore,
  sessionId: string,
  options?: CheckpointHistoryOptions
): Promise<CheckpointHistoryEntry[] | undefined> {
  return store.history?.(sessionId, options);
}

/** Validate a store's `historyLimit` (a non-negative integer; `0` keeps no history). */
export function resolveHistoryLimit(limit: number | undefined): number {
  const value = limit ?? DEFAULT_CHECKPOINT_HISTORY_LIMIT;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`historyLimit must be a non-negative integer, got ${limit}.`);
  }
  return value;
}

/** Build the history entry for a checkpoint saved now. */
export function toHistoryEntry(checkpoint: Checkpoint, savedAt: Date = new Date()): CheckpointHistoryEntry {
  return {
    step: checkpoint.stepIndex,
    savedAt: savedAt.toISOString(),
    status: checkpoint.status ?? 'in-progress',
    checkpoint,
  };
}

/** Append to an oldest-first ring, dropping the oldest past `limit`. */
export function appendToRing<T>(ring: readonly T[], entry: T, limit: number): T[] {
  return limit === 0 ? [] : [...ring, entry].slice(-limit);
}

/** An oldest-first ring as a newest-first list, at most `options.limit` long. */
export function newestFirst<T>(ring: readonly T[], options?: CheckpointHistoryOptions): T[] {
  const list = [...ring].reverse();
  const limit = options?.limit;
  return limit === undefined ? list : list.slice(0, Math.max(0, limit));
}

/**
 * Default CheckpointStore backed by the SDK's StorageService, keyed by
 * `checkpoints/{sessionId}.json`.
 */
export class LocalStorageCheckpointStore implements CheckpointStore {
  private readonly historyLimit: number;

  /**
   * @param options.historyLimit checkpoints kept per session in `history()` (default 50, `0` keeps none)
   */
  constructor(
    private readonly storageService: StorageService,
    options: { historyLimit?: number } = {}
  ) {
    this.historyLimit = resolveHistoryLimit(options.historyLimit);
  }

  private getStorageKey(sessionId: string): string {
    return `checkpoints/${sessionId}.json`;
  }

  private getHistoryKey(sessionId: string): string {
    return `checkpoint-history/${sessionId}.json`;
  }

  private readRing(sessionId: string): CheckpointHistoryEntry[] {
    const key = this.getHistoryKey(sessionId);
    return this.storageService.fileExists(key)
      ? this.storageService.readPlainJSONAttachment<CheckpointHistoryEntry[]>(key)
      : [];
  }

  async save(sessionId: string, checkpoint: Checkpoint): Promise<void> {
    const storageKey = this.getStorageKey(sessionId);
    await this.storageService.acquireLock(storageKey);
    try {
      this.storageService.writePlainJSONAttachment(storageKey, checkpoint);
      if (this.historyLimit > 0) {
        const ring = appendToRing(this.readRing(sessionId), toHistoryEntry(checkpoint), this.historyLimit);
        this.storageService.writePlainJSONAttachment(this.getHistoryKey(sessionId), ring);
      }
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

  async delete(sessionId: string, options: CheckpointDeleteOptions = {}): Promise<void> {
    // deleteAttachment already swallows "not found" (it no-ops if the file
    // doesn't exist), so no extra try/catch is needed here.
    this.storageService.deleteAttachment(this.getStorageKey(sessionId));
    if (!options.keepHistory) this.storageService.deleteAttachment(this.getHistoryKey(sessionId));
  }

  async history(sessionId: string, options?: CheckpointHistoryOptions): Promise<CheckpointHistoryEntry[]> {
    const storageKey = this.getStorageKey(sessionId);
    await this.storageService.acquireLock(storageKey);
    try {
      return newestFirst(this.readRing(sessionId), options);
    } finally {
      this.storageService.releaseLock(storageKey);
    }
  }
}
