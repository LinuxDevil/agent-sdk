/**
 * Approval Gate
 * Types and storage for human-in-the-loop tool approval.
 */

import { Message, ToolCall } from '../providers';
import { AgentConfig } from '../types';
import { StorageService, readJSONAttachmentLocked } from '../storage/StorageService';
import type { RunUsage } from '../models/usage';
import type { AgentFingerprint } from './agentFingerprint';
import type { Principal } from '../auth/types';

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
  /**
   * LOU-X9: what the pause asks the human for. `'question'` for a call of the
   * built-in `ask_question` tool (see `question`); absent for a tool call
   * waiting on approval.
   */
  kind?: ApprovalKind;
  /** LOU-X9: the question to show, when `kind` is `'question'`. */
  question?: ApprovalQuestion;
  /**
   * N9b: where to sign in, when `kind` is `'sign-in'`: the tool called
   * `ctx.getToken()` for a provider the user has no token for yet.
   */
  signIn?: ApprovalSignIn;
  /**
   * N10b: who the paused run acts for (docs/auth.md), so an `approve`
   * callback or a channel's `approvers` function can see whose call it is.
   * Absent for a run without a principal.
   */
  principal?: Principal;
}

/**
 * LOU-X9: what a pending approval asks for. Absent on a record means `'tool'`.
 * N9b: `'sign-in'` when a tool needs the user to sign in to an OAuth provider.
 */
export type ApprovalKind = 'tool' | 'question' | 'sign-in';

/** N9b: the sign-in a `kind: 'sign-in'` pause waits on. */
export interface ApprovalSignIn {
  /** The provider's `name` (its token store key). */
  provider: string;
  /** The provider's `displayName`, e.g. `'GitHub'`. */
  displayName?: string;
  /** The authorization URL to open (it carries the `state` and the PKCE challenge, never a secret). */
  url: string;
  /** Set once the provider redirected back with an error (the user declined): approving then cancels the call. */
  declined?: boolean;
}

/** LOU-X9: the question an `ask_question` call puts to the user. */
export interface ApprovalQuestion {
  text: string;
  /** Choices to offer, in order; the tool result's `option` is an index into them. */
  options?: string[];
  /** With `options`: `false` means the answer must be one of them. */
  allowFreeText?: boolean;
}

/** LOU-X9: the name of the built-in question tool (`askQuestionTool()`). */
export const ASK_QUESTION_TOOL_NAME = 'ask_question';

/**
 * LOU-X9: `pending` with `kind: 'question'` and its `question` filled in when
 * it is an `ask_question` call; any other record is returned as is.
 */
export function describeApproval(pending: PendingApproval): PendingApproval {
  if (pending.kind !== undefined || pending.toolName !== ASK_QUESTION_TOOL_NAME) return pending;
  const { question, options, allowFreeText } = pending.args;
  return {
    ...pending,
    kind: 'question',
    question: {
      text: String(question ?? ''),
      ...(Array.isArray(options) && { options: options.map(String) }),
      ...(typeof allowFreeText === 'boolean' && { allowFreeText }),
    },
  };
}

/**
 * A human decision resolving a PendingApproval. For a question (LOU-X9),
 * `approved: true` with the answer as `note` answers it; `approved: false`
 * declines to answer.
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
  /**
   * LOU-U7: the tool calls of the same model turn that come after the
   * paused one and have not run yet, in call order. `resumeAfterApproval()`
   * records the paused call's result (or rejection) and then runs these
   * through the normal batch path - they can run, fail validation, or pause
   * the run again on another approval. Absent on snapshots saved before
   * this field existed, which means "no remaining calls": any call of that
   * turn still without a result gets an error result saying it was not run,
   * so the transcript stays valid for the provider.
   */
  remainingToolCalls?: ToolCall[];
  /** Usage the paused run had spent (LOU-V5), so the resumed run continues its totals. */
  usage?: RunUsage;
  /**
   * LOU-Y1: set when the run paused because a sub-agent it called paused for
   * approval. `pendingToolCall` is then the sub-agent's call, and
   * `resumeAfterApproval()` re-enters the sub-agent instead of running a tool
   * of this run.
   */
  subagent?: SubagentSuspension;
  /**
   * LOU-W9.2: the fingerprint of the agent that paused (for a sub-agent's
   * nested snapshot, of that sub-agent). `resumeAfterApproval()` compares it
   * with the resuming agent's (`onAgentDrift`). Absent on older snapshots,
   * which resume without any check.
   */
  agentFingerprint?: AgentFingerprint;
  /**
   * N10b: who the paused run acts for. `resumeAfterApproval()` runs the
   * approved call and the rest of the run as this principal, whoever decides
   * (the decider is the approver, `ctx.approval.by`). Absent for a run without
   * one and on older snapshots (they resume with no principal).
   */
  principal?: Principal;
  /**
   * LOU-R16: the paused run's `ExecuteOptions.metadata`, so the resumed run's
   * hook contexts keep seeing it when the resuming call passes none. Absent
   * for a run without one and on older snapshots.
   */
  metadata?: Record<string, unknown>;
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
  /**
   * M4: set when the suspended call is an `agent_await` waiting on background
   * sub-agent tasks paused for approval. Kept here, not in `args`, so the
   * model never sees it.
   */
  background?: SuspendedBackgroundTasks;
}

/** M4: the background tasks an `agent_await` call paused on (see {@link SubagentSuspension.background}). */
export interface SuspendedBackgroundTasks {
  /** The `task` call (`agent`, `prompt`, `description`) of the task this suspension pauses on (its run is `snapshot`). */
  task: Record<string, unknown>;
  /** The other awaited tasks still paused, in order: the run pauses on each in turn once this one is decided. */
  waiting: PausedBackgroundTask[];
}

/** M4: a background sub-agent task paused for approval, kept until an `agent_await` call resumes it. */
export interface PausedBackgroundTask {
  taskId: string;
  /** The `task` call that started it (`agent`, `prompt`, `description`). */
  task: Record<string, unknown>;
  /** The sub-agent's paused run. */
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
  /**
   * The record `resolve(id)` would return, without claiming or deleting it:
   * `null` when `id` is unknown or already resolved. Optional (like
   * `CheckpointStore.history`): `agent.approvals.get()` reads a pause another
   * process saved only through it. All built-in stores implement it.
   */
  load?(id: string): Promise<ResolvedApproval | null>;
}

/**
 * Default ApprovalStore backed by the SDK's StorageService.
 *
 * Follows the pattern StorageService documents and tests: acquireLock ->
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
    // Delete-on-read, inside the same lock that guards the read.
    return readJSONAttachmentLocked<ResolvedApproval>(this.storageService, storageKey, () =>
      this.storageService.deleteAttachment(storageKey)
    );
  }

  async load(id: string): Promise<ResolvedApproval | null> {
    return readJSONAttachmentLocked<ResolvedApproval>(this.storageService, this.getStorageKey(id));
  }
}
