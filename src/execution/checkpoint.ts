/**
 * Checkpoint
 * Backend-agnostic durable-execution checkpointing for AgentExecutor runs.
 */

import { Message } from '../providers';
import { StorageService } from '../storage';

/**
 * A snapshot of an in-progress agent run, saved after each tool result so
 * execution can resume from here (e.g. after a process restart).
 */
export interface Checkpoint {
  agentId: string;
  sessionId: string;
  stepIndex: number;
  messages: Message[];
  toolCalls: unknown[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
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
   */
  businessState?: unknown;
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
