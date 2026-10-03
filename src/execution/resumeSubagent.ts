/**
 * resumeAfterApproval() for a run that paused because one of its sub-agents
 * paused (LOU-Y1). The decision is for the sub-agent's call, so instead of
 * running a tool of this run, the parent's tool call (`task` or a delegate
 * tool) is re-entered: it resumes the sub-agent with the decision (which
 * runs or rejects the sub-agent's pending call and lets it finish), and the
 * sub-agent's final answer becomes that tool call's result. If the
 * sub-agent pauses again, the run pauses again with a new approval record.
 */

import type { LLMProvider, Message } from '../providers';
import type { ToolRegistry } from '../tools';
import { withSubagents } from '../subagents/withSubagents';
import type { ApprovalDecision, ApprovalStore, ExecutionSnapshot, PendingApproval, SubagentSuspension } from './ApprovalGate';
import type { ExecuteOptions, ExecutionResult } from './AgentExecutor';
import type { RunUsage } from '../models/usage';
import { mergeDelegatedUsage } from './runUsage';
import { runEventsOf } from './agentRun';
import type { ResumeExecuteOptions } from './resume';
import type { Principal } from '../auth/types';
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
  /** N14: the run's provider (a decided `run_code` call rebuilds its tool with it). */
  provider: LLMProvider;
  /** The resumed run's usage so far: a resumed sub-agent's usage is added to it (LOU-V5). */
  usage: RunUsage;
  /** `AgentExecutor.execute` and `resumeAfterApproval`, for the sub-agent. */
  execute: (options: ExecuteOptions) => Promise<ExecutionResult>;
  resumeRun: ResumeRun;
  /** N10b: who decided (`ResumeExecuteOptions.approver`), frozen. */
  approver?: Readonly<Principal>;
  /** #281: the continued run's `invoke_agent` span, the parent of the decided call's `execute_tool` span. */
  runSpanId?: string;
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
  // LOU-Y6: under the paused run's sessionId, so the child's transcript is saved where the lead finds it.
  const { toolRegistry } = await withSubagents(ctx.snapshot.agent, ctx.toolRegistry, executeOptions.subagents, {
    maxSubagentDepth: executeOptions.maxSubagentDepth,
    sessionId: ctx.snapshot.sessionId,
  });
  const parentCall: PendingApproval = {
    ...ctx.snapshot.pendingToolCall,
    toolCallId: suspension.toolCallId,
    toolName: suspension.toolName,
    args: suspension.args,
  };
  const scope: ToolCallScope = {
    runtime: { ...executeOptions, approvalStore: ctx.approvalStore },
    toolCallId: suspension.toolCallId,
    onDelegatedUsage: (child) => mergeDelegatedUsage(ctx.usage, child),
    execute: ctx.execute,
    resume: { decision: ctx.decision, suspension, run: ctx.resumeRun, ...(ctx.approver && { approver: ctx.approver }) },
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
  const { usage } = ctx;
  const record = suspensionRecord(snapshot, { messages, steps: snapshot.steps, usage, fingerprint: snapshot.agentFingerprint }, suspension);
  await ctx.approvalStore.save(record.pending, record.snapshot);
  // LOU-V14: a streamed resume reports the new pause like a fresh run does.
  runEventsOf(ctx.executeOptions as ExecuteOptions)?.approvalRequested(record.pending);
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
