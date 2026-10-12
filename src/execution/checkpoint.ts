/**
 * Checkpoint
 * Backend-agnostic durable-execution checkpointing for AgentExecutor runs.
 */

import type { Message, ProviderUsage } from '../providers';
import { readJSONAttachmentLocked, type StorageService } from '../storage/StorageService';
import type { StepUsage } from '../models/usage';
import type { CheckpointUsage } from './runUsage';
import type { AgentFingerprint } from './agentFingerprint';
import { ConfigurationError, SDKError } from './errors';
import type { ApprovalKind, ApprovalStore } from './ApprovalGate';
import type { Principal } from '../auth/types';

/** Key of `AgentConfig.metadata` holding a dynamic run's `ctx` and model (LOU-V15): saved in approval snapshots and checkpoints. */
export const RUN_CONFIG_KEY = 'loushoRunConfig';

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

/** Eve DUR-F11: a failed attempt at a checkpointed session turn (`Checkpoint.lastError`). */
export interface CheckpointError {
  message: string;
  /** The error's `LOUSHO_*` code, when it has one. */
  code?: string;
  /** For a provider error: its compacted category (`'context-length-exceeded'`, `'rate-limit'`, ...). */
  category?: string;
  /** False for a provider error that will not go away (context length, auth, another 4xx); true for a crash, a network error, a 5xx or an unclassified failure. */
  retryable: boolean;
  /** When the attempt failed (ISO 8601). */
  at: string;
}

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
  /** LOU-U8: with `status: 'awaiting-approval'`, the id of the pending approval (the first of `approvalIds`). */
  approvalId?: string;
  /**
   * Eve TOOLS-F12: with `status: 'awaiting-approval'`, every approval of the
   * paused step not decided yet, in call order, when there are several.
   * Absent for a step paused on one call and on older checkpoints.
   */
  approvalIds?: string[];
  /**
   * Eve DUR-F11: why the last attempt at a session's turn failed, written by
   * the session when its run throws. A provider error that retrying cannot fix
   * (`retryable: false`, e.g. a 400) makes `send()` fail with
   * `LOUSHO_SESSION_TURN_FAILED` instead of replaying the turn.
   */
  lastError?: CheckpointError;
  /** Eve DUR-F11: how many attempts at the session's turn failed so far. */
  attempts?: number;
  /**
   * M10a: with `status: 'awaiting-approval'`, `'question'` when the pending
   * approval is an `ask_question` call (`PendingApproval.kind`), so a
   * process that did not make the pause can tell a question from a tool
   * approval. Absent for a tool approval and on older checkpoints.
   */
  approvalKind?: ApprovalKind;
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
  /**
   * N10b: who the run acts for (`ExecuteOptions.principal`, docs/auth.md), so a
   * resumed unfinished run acts for the same caller. It may hold personal data
   * from the token's claims, like the transcript. Absent for a run without
   * one and on older checkpoints (they resume with no principal).
   */
  principal?: Principal;
  /**
   * LOU-R16: the run's `ExecuteOptions.metadata` (the hook contexts'
   * `ctx.metadata`), so a resumed unfinished run's hooks keep seeing it when
   * the resuming call passes none. Absent for a run without one and on older
   * checkpoints.
   */
  metadata?: Record<string, unknown>;
  /**
   * Tool calls an approval resume started (approved calls) and whose results
   * were not saved yet. A run resumed from this checkpoint does not run them
   * again: each gets a `kind: 'interrupted'` error result saying it may or may
   * not have taken effect (approved calls run at most once, see
   * docs/durable-execution.md). Absent otherwise.
   */
  startedToolCallIds?: string[];
  /**
   * Eve DUR-F17: present on a flow run's checkpoint (`FlowExecutor` with a
   * `checkpointStore` and `runId`): where the flow stands. Opaque to agent runs.
   */
  flow?: FlowCheckpointState;
}

/**
 * Eve TOOLS-F12: the approvals a paused checkpoint waits on - `approvalIds`
 * when the step paused on several calls, else its one `approvalId`; empty
 * when it waits on none.
 */
export function pausedApprovalIds(checkpoint: Pick<Checkpoint, 'approvalId' | 'approvalIds'>): string[] {
  if (checkpoint.approvalIds && checkpoint.approvalIds.length > 0) return [...checkpoint.approvalIds];
  return checkpoint.approvalId === undefined ? [] : [checkpoint.approvalId];
}

/**
 * A built-in checkpoint store's cheap check whether an id has checkpoint
 * history, without reading it (internal; other stores are asked for one entry).
 */
export const HAS_CHECKPOINT_HISTORY = Symbol.for('lousho.hasCheckpointHistory');

/**
 * Whether `checkpoint` waits on approvals none of which `approvalStore` holds
 * unclaimed any more: a resolver claimed them and died before it marked the
 * run (or they were deleted). Such a pause can never be decided, so a resume
 * of the run under its lease pauses it again instead. `false` when the store
 * cannot read a record without claiming it (no `load`).
 */
export async function orphanedPause(checkpoint: Pick<Checkpoint, 'status' | 'approvalId' | 'approvalIds'>, approvalStore: ApprovalStore | undefined): Promise<boolean> {
  if (checkpoint.status !== 'awaiting-approval' || !approvalStore?.load) return false;
  const ids = pausedApprovalIds(checkpoint);
  if (ids.length === 0) return false;
  for (const id of ids) if (await approvalStore.load(id)) return false;
  return true;
}

/** Eve DUR-F17: a flow run's state in its {@link Checkpoint} (`checkpoint.flow`). */
export interface FlowCheckpointState {
  /** The flow's `code`; a resume with another flow is refused. */
  code: string;
  /** A hash of the flow's step structure (types, ids, tools, order); a resume with a flow whose steps changed is refused. Absent on older checkpoints. */
  structure?: string;
  /** The flow's variables after the last completed node. */
  variables: Record<string, unknown>;
  /** Structural ids (`0`, `0.1`, `0.1.2`, ...) of the nodes that completed, children of a completed node omitted. */
  completedNodeIds: string[];
  /** The result of each completed node, by its id in `completedNodeIds`. */
  nodeResults: Record<string, unknown>;
  /** The option index each `oneOf` node picked (`-1` for none), so a resume takes the same branch. */
  choices: Record<string, number>;
  /** Model usage of the run so far. */
  usage: ProviderUsage;
  /** Completed steps so far (`result.steps`). */
  steps: number;
  /** With `status: 'finished'`: the flow's output. */
  output?: unknown;
  /** With `status: 'awaiting-approval'`: the `toolCall` step the run is paused on. */
  pendingApproval?: FlowPendingApproval;
}

/** Eve DUR-F17: a flow `toolCall` step paused until its approval is decided. */
export interface FlowPendingApproval {
  /** Pass it back as `FlowExecutor.resume(flow, { ..., approval: { approvalId, approved } })`. */
  approvalId: string;
  /** The step's id in `completedNodeIds` terms. */
  nodeId: string;
  /** The tool waiting to run. */
  toolName: string;
  /** The arguments the tool will run with once approved. */
  args: Record<string, unknown>;
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
  /** The checkpoint as it was saved. */
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
  /** Saves `checkpoint` as the latest of `sessionId` (and appends it to the history, when the store keeps one). */
  save(sessionId: string, checkpoint: Checkpoint): Promise<void>;
  /** The latest checkpoint of `sessionId`, or `null` when there is none. */
  load(sessionId: string): Promise<Checkpoint | null>;
  /** Deletes the checkpoint of `sessionId` (and its history unless `keepHistory`); a missing id is not an error. */
  delete(sessionId: string, options?: CheckpointDeleteOptions): Promise<void>;
  /** Saved checkpoints of the session, newest first; `[]` when there are none. */
  history?(sessionId: string, options?: CheckpointHistoryOptions): Promise<CheckpointHistoryEntry[]>;
  /**
   * Eve DUR-F15: the latest checkpoint of every id the store holds, ordered by
   * id, optionally only those with a given `status` - e.g.
   * `list({ status: ['in-progress', 'awaiting-approval'] })` finds the runs a
   * crash interrupted. Optional; the file, SQLite, KV (when the namespace
   * binding has `list`) and in-memory stores implement it. `agent.pending()`
   * is built on it.
   */
  list?(options?: CheckpointListOptions): Promise<CheckpointListEntry[]>;
  /**
   * Run lease (optional): atomically takes, or renews, the lease on `sessionId`
   * for `owner` until `ttlMs` from now, unless another owner holds a lease that
   * has not expired. Resolves `true` when `owner` holds it afterwards. A
   * checkpointed run holds the lease on its id while it executes (renewing it
   * every `ttlMs / 3`), so another process, replica or store object cannot
   * resume the same run at the same time: it fails with `LOUSHO_SESSION_BUSY`
   * before anything runs. A store without it runs without leases. The file,
   * SQLite, KV (best effort) and in-memory stores implement it. See
   * docs/durable-execution.md#run-leases.
   */
  acquireLease?(sessionId: string, owner: string, ttlMs: number): Promise<boolean>;
  /**
   * Run lease heartbeat (optional): extends `owner`'s lease on `sessionId` to
   * `ttlMs` from now only when `owner` still holds it (expired or not, as long
   * as no other owner took it); `false` when the lease is gone or another
   * owner's. Unlike `acquireLease`, it never takes a lease that was released,
   * so a run that stalled while another process finished the run notices.
   * Without it the heartbeat calls `acquireLease`.
   */
  renewLease?(sessionId: string, owner: string, ttlMs: number): Promise<boolean>;
  /**
   * Fenced save (optional): `save(sessionId, checkpoint)`, atomically with a
   * check that `owner` still holds the lease on `sessionId`; resolves `false`,
   * saving nothing, when it does not. A run saves its checkpoints this way, so
   * a run that lost its lease cannot overwrite the new holder's progress.
   * Without it a run renews its lease (`renewLease`) right before each save.
   */
  saveIfLeased?(sessionId: string, checkpoint: Checkpoint, owner: string): Promise<boolean>;
  /** Releases `owner`'s lease on `sessionId`; a lease another owner holds is left alone. */
  releaseLease?(sessionId: string, owner: string): Promise<void>;
}

/** Options for {@link CheckpointStore.list} (Eve DUR-F15). */
export interface CheckpointListOptions {
  /** Only checkpoints with this status, or one of these (a checkpoint without one counts as `'in-progress'`). Default: all. */
  status?: CheckpointStatus | readonly CheckpointStatus[];
}

/** One checkpoint listed by {@link CheckpointStore.list} (Eve DUR-F15). */
export interface CheckpointListEntry {
  /** The id it is saved under: `save(sessionId, checkpoint)`'s `sessionId`. */
  sessionId: string;
  /** `checkpoint.status`, `'in-progress'` when the checkpoint has none. */
  status: CheckpointStatus;
  /** The latest checkpoint saved under `sessionId`. */
  checkpoint: Checkpoint;
}

/**
 * Eve DUR-F15: the entries of `checkpoints` (`[id, checkpoint]` pairs) that
 * `options` selects, ordered by id - the shared body of the stores' `list()`.
 */
export function listCheckpoints(checkpoints: Iterable<readonly [string, Checkpoint]>, options: CheckpointListOptions = {}): CheckpointListEntry[] {
  const wanted = options.status === undefined ? undefined : new Set<CheckpointStatus>(typeof options.status === 'string' ? [options.status] : options.status);
  const entries: CheckpointListEntry[] = [];
  for (const [sessionId, checkpoint] of checkpoints) {
    const status = checkpoint.status ?? 'in-progress';
    if (!wanted || wanted.has(status)) entries.push({ sessionId, status, checkpoint });
  }
  return entries.sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
}

/**
 * Parses a stored checkpoint, throwing `LOUSHO_CHECKPOINT_CORRUPT` (naming
 * `id` and `where`) when it is not valid JSON or not a checkpoint - a write
 * cut short by a crash or power loss - instead of a raw `SyntaxError`.
 */
export function parseCheckpoint(raw: string, id: string, where: string, reviver?: (key: string, value: unknown) => unknown): Checkpoint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw, reviver);
  } catch (error) {
    throw checkpointCorrupt(id, where, 'it is not valid JSON', error);
  }
  return assertCheckpointShape(parsed, id, where);
}

/** `value` when it has a checkpoint's shape (an object with a `messages` array), else `LOUSHO_CHECKPOINT_CORRUPT`. */
function assertCheckpointShape(value: unknown, id: string, where: string): Checkpoint {
  const candidate = value as Partial<Checkpoint> | null;
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate) || !Array.isArray(candidate.messages)) {
    throw checkpointCorrupt(id, where, 'it is not a checkpoint object');
  }
  return candidate as Checkpoint;
}

function checkpointCorrupt(id: string, where: string, why: string, cause?: unknown): SDKError {
  return new SDKError(
    `The checkpoint of '${id}' in ${where} is corrupt: ${why} (a write cut short by a crash or power loss?). ` +
      "Drop it with session.discardPending() / session.clear() (or checkpointStore.delete(id)); its run cannot be resumed.",
    'LOUSHO_CHECKPOINT_CORRUPT',
    cause === undefined ? undefined : { cause }
  );
}

/** Whether `error` is the `LOUSHO_CHECKPOINT_CORRUPT` error of {@link parseCheckpoint}. */
export function isCheckpointCorrupt(error: unknown): boolean {
  return error instanceof SDKError && error.code === 'LOUSHO_CHECKPOINT_CORRUPT';
}

/**
 * What a store's `list()` reports for a checkpoint it cannot read: an
 * `'in-progress'` entry whose `lastError` (`LOUSHO_CHECKPOINT_CORRUPT`, not
 * retryable) says why, so `agent.pending()` shows the run that `send()` /
 * `resume()` fail on instead of hiding it.
 */
function corruptCheckpointEntry(id: string, error: unknown): [string, Checkpoint] {
  return [
    id,
    {
      agentId: '',
      sessionId: id,
      stepIndex: 0,
      messages: [],
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      status: 'in-progress',
      lastError: {
        message: error instanceof Error ? error.message : String(error),
        code: 'LOUSHO_CHECKPOINT_CORRUPT',
        retryable: false,
        at: new Date().toISOString(),
      },
    },
  ];
}

/** A store's `list()` entry for `id`: the checkpoint `read()` parses, or {@link corruptCheckpointEntry} when it throws. */
export function listedCheckpoint(id: string, read: () => Checkpoint): readonly [string, Checkpoint] {
  try {
    return [id, read()];
  } catch (error) {
    return corruptCheckpointEntry(id, error);
  }
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
    throw new ConfigurationError(`historyLimit must be a non-negative integer, got ${limit}.`, 'historyLimit');
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
    return readJSONAttachmentLocked<Checkpoint>(this.storageService, this.getStorageKey(sessionId));
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
