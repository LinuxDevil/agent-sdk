/**
 * Approval Gate
 * Types and storage for human-in-the-loop tool approval.
 */

import { Message } from '../providers';
import { AgentConfig } from '../types';

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
}
