/**
 * resumeAfterApproval() for a run that paused because one of its sub-agents
 * paused (LOU-Y1). The decision is for the sub-agent's call, so instead of
 * running a tool of this run, the parent's tool call (`task` or a delegate
 * tool) is re-entered: it resumes the sub-agent with the decision (which
 * runs or rejects the sub-agent's pending call and lets it finish), and the
 * sub-agent's final answer becomes that tool call's result. If the
 * sub-agent pauses again, the run pauses again with a new approval record.
 */

import type { Message } from '../providers';
import type { ToolRegistry } from '../tools';
import { withSubagents } from '../subagents/withSubagents';
import type { ApprovalDecision, ApprovalStore, ExecutionSnapshot, PendingApproval, SubagentSuspension } from './ApprovalGate';
import type { ExecuteOptions, ExecutionResult } from './AgentExecutor';
import type { ResumeExecuteOptions } from './resume';
import {
  SubagentApprovalPause,
  suspensionRecord,
  toSuspension,
  type ResumeRun,
  type ToolCallScope,
} from './subagentRuntime';

/** What resuming a paused run needs from resumeAfterApproval(). */
export interface ResumeContext {
  decision: ApprovalDecision;
  approvalStore: ApprovalStore;
  snapshot: ExecutionSnapshot;
  messages: Message[];
  toolRegistry: ToolRegistry;
  executeOptions: ResumeExecuteOptions;
  /** `AgentExecutor.execute` and `resumeAfterApproval`, for the sub-agent. */
  execute: (options: ExecuteOptions) => Promise<ExecutionResult>;
  resumeRun: ResumeRun;
}

/** Runs an approved tool call of the paused run and returns its `tool` message. */
type RunApprovedToolCall = (pending: PendingApproval, toolRegistry: ToolRegistry, scope: ToolCallScope) => Promise<Message>;

/**
 * Re-enters the tool call whose sub-agent paused. Resolves to its `tool`
 * message, or to the result to return when the sub-agent paused again.
 */
export async function resumeSubagentCall(
  ctx: ResumeContext,
  suspension: SubagentSuspension,
  runApproved: RunApprovedToolCall
): Promise<{ message: Message } | { paused: ExecutionResult }> {
  const { executeOptions } = ctx;
  // The `task` tool is per run: rebuild it from the same `subagents` option.
  const { toolRegistry } = await withSubagents(
    ctx.snapshot.agent,
    ctx.toolRegistry,
    executeOptions.subagents,
    executeOptions.maxSubagentDepth
  );
  const parentCall: PendingApproval = {
    ...ctx.snapshot.pendingToolCall,
    toolCallId: suspension.toolCallId,
    toolName: suspension.toolName,
    args: suspension.args,
  };
  const scope: ToolCallScope = {
    runtime: { ...executeOptions, approvalStore: ctx.approvalStore },
    toolCallId: suspension.toolCallId,
    execute: ctx.execute,
    resume: { decision: ctx.decision, suspension, run: ctx.resumeRun },
  };
  try {
    return { message: await runApproved(parentCall, toolRegistry ?? ctx.toolRegistry, scope) };
  } catch (error) {
    if (!(error instanceof SubagentApprovalPause)) throw error;
    return { paused: await pauseAgain(ctx, toSuspension(error, suspension)) };
  }
}

/** Saves a new approval record for the sub-agent's next pending call. */
async function pauseAgain(ctx: ResumeContext, suspension: SubagentSuspension): Promise<ExecutionResult> {
  const { snapshot, messages } = ctx;
  const record = suspensionRecord(snapshot, { messages, steps: snapshot.steps }, suspension);
  await ctx.approvalStore.save(record.pending, record.snapshot);
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  ctx.executeOptions.onEvent?.({ type: 'finish', timestamp: new Date(), finishReason: 'awaiting-approval', usage });
  return {
    text: '',
    messages,
    toolCalls: [],
    usage,
    finishReason: 'awaiting-approval',
    steps: snapshot.steps,
    approvalId: record.pending.id,
  };
}
