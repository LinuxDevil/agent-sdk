/**
 * Approval Gate
 * Types and storage for human-in-the-loop tool approval.
 */

import { Message } from '../providers';
import { AgentConfig } from '../types';
import { StorageService } from '../storage';
import type { RunUsage } from '../models/usage';

/**
 * A tool call that is waiting on a human decision before it can execute.
 */
export interface PendingApproval {
  id: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  agentId?: string;
  createdAt: string;
  /**
   * LOU-Y1: set when the call belongs to a sub-agent - the names of the
   * sub-agents it runs inside, outermost first (e.g. `['researcher']`).
   * Absent for the top-level agent's own tool calls.
   */
  subagentPath?: string[];
}

/**
 * A human decision resolving a PendingApproval.
 */
export interface ApprovalDecision {
  id: string;
  approved: boolean;
  note?: string;
}

/**
 * Enough state to resume an AgentExecutor.execute() run once a
 * PendingApproval has been resolved.
 */
export interface ExecutionSnapshot {
  agent: AgentConfig;
  currentMessages: Message[];
  pendingToolCall: PendingApproval;
  steps: number;
  /**
   * The sessionId the paused AgentExecutor.execute() run was using for
   * durable-execution checkpointing (LOU-C9/C10), if any. Recorded so that
   * resume.ts can proactively invalidate any stale checkpoint left behind
   * under this sessionId once the approval is resolved - a checkpoint
   * saved before the pause is stale by construction, since a pause always
   * happens before the paused tool's result (and thus the next checkpoint
   * write) exists. Undefined when the paused run wasn't using durable
   * execution at all.
   */
  sessionId?: string;
  /** Usage the paused run had spent (LOU-V5), so the resumed run continues its totals. */
  usage?: RunUsage;
  /**
   * LOU-Y1: set when the run paused because a sub-agent it called paused for
   * approval. `pendingToolCall` is then the sub-agent's call, and
   * `resumeAfterApproval()` re-enters the sub-agent instead of running a tool
   * of this run.
   */
  subagent?: SubagentSuspension;
}

/**
 * A tool call of a paused run (a `task` or delegate tool call) whose
 * sub-agent is itself paused for approval. Plain data, so it is stored with
 * the rest of the snapshot.
 */
export interface SubagentSuspension {
  /** The parent's tool call that is waiting on the sub-agent. */
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** The sub-agent's name. */
  agentName: string;
  /** The sub-agent's own paused run (which may itself wait on a sub-agent). */
  snapshot: ExecutionSnapshot;
}

/**
 * A resolved approval record: the original pending tool call plus the
 * snapshot needed to resume execution.
 */
export interface ResolvedApproval {
  pending: PendingApproval;
  snapshot: ExecutionSnapshot;
}

/**
 * Persists PendingApprovals (and the ExecutionSnapshot needed to resume
 * them) so a paused agent run can survive a process restart.
 */
export interface ApprovalStore {
  save(pending: PendingApproval, snapshot: ExecutionSnapshot): Promise<void>;
  resolve(id: string): Promise<ResolvedApproval | null>;
}

/**
 * Default ApprovalStore backed by the SDK's StorageService.
 *
 * Note: MemoryManager.ts (referenced by the LOU-C3 ticket as the source of
 * the "lock then read/write JSON" pattern) actually stores memories through
 * a MemoryRepository/data-layer abstraction, not StorageService directly -
 * there is no existing lock+JSON-against-StorageService usage elsewhere in
 * this codebase to copy verbatim. This implementation instead follows the
 * pattern StorageService itself documents and tests: acquireLock ->
 * read/write*JSON*Attachment -> releaseLock.
 */
export class StorageServiceApprovalStore implements ApprovalStore {
  constructor(private readonly storageService: StorageService) {}

  private getStorageKey(id: string): string {
    return `approvals/${id}.json`;
  }

  async save(pending: PendingApproval, snapshot: ExecutionSnapshot): Promise<void> {
    const storageKey = this.getStorageKey(pending.id);
    await this.storageService.acquireLock(storageKey);
    try {
      const record: ResolvedApproval = { pending, snapshot };
      this.storageService.writePlainJSONAttachment(storageKey, record);
    } finally {
      this.storageService.releaseLock(storageKey);
    }
  }

  async resolve(id: string): Promise<ResolvedApproval | null> {
    const storageKey = this.getStorageKey(id);
    await this.storageService.acquireLock(storageKey);
    try {
      if (!this.storageService.fileExists(storageKey)) {
        return null;
      }
      const record = this.storageService.readPlainJSONAttachment<ResolvedApproval>(storageKey);
      this.storageService.deleteAttachment(storageKey);
      return record;
    } finally {
      this.storageService.releaseLock(storageKey);
    }
  }
}
