/**
 * Runtime plumbing that lets a child agent run (a sub-agent started by the
 * `task` tool or by `createDelegateTool()`) inherit from the parent run that
 * called it (LOU-Y1).
 *
 * The executor binds a {@link ToolCallScope} - the parent run's runtime
 * options, the calling tool call and its span - to the options object every
 * tool's `execute(args, options)` receives, so the delegation core can read
 * it without anything going through the tool arguments (which the model
 * controls) and without async-context globals (unavailable on Workers).
 */

import type { LLMProvider, Message } from '../providers';
import type { AgentConfig } from '../types';
import type { ToolRegistry } from '../tools/ToolRegistry';
import type {
  ApprovalDecision,
  ApprovalStore,
  ExecutionSnapshot,
  PendingApproval,
  SubagentSuspension,
} from './ApprovalGate';
import type { ExecuteOptions, ExecutionResult } from './AgentExecutor';
import type { RunUsage } from '../models/usage';
import type { ResumeExecuteOptions } from './resume';
import { PropagatingToolError } from './propagatingToolError';
import { toolErrorResult } from './toolErrors';

/** The parent run options a child run inherits. */
export type InheritedRuntime = Pick<
  ExecuteOptions,
  | 'hooks'
  | 'exporter'
  | 'captureContent'
  | 'redactContent'
  | 'approvalStore'
  | 'toolConcurrency'
  | 'sandbox'
  | 'signal'
  | 'onEvent'
  | 'maxSubagentDepth'
  | 'permissions'
  | 'onPermissionDecision'
  | 'guardrails'
>;

/** What the executor knows about the tool call that is running. */
export interface ToolCallScope {
  runtime: InheritedRuntime;
  toolCallId: string;
  /** The tool call's `execute_tool` span, when traced. */
  spanId?: string;
  /**
   * Adds a child run's usage to the parent's totals - set by
   * resumeAfterApproval(); the executor hands tools `onDelegatedUsage`
   * in their execute options instead (LOU-V5).
   */
  onDelegatedUsage?: (usage: RunUsage) => void;
  /** Runs a child agent (`AgentExecutor.execute`). */
  execute: (options: ExecuteOptions) => Promise<ExecutionResult>;
  /** Set by resumeAfterApproval() when this call re-enters a paused sub-agent. */
  resume?: { decision: ApprovalDecision; suspension: SubagentSuspension; run: ResumeRun };
}

/** `resumeAfterApproval()`, handed to the delegation core to resume a child. */
export type ResumeRun = (
  decision: ApprovalDecision,
  approvalStore: ApprovalStore,
  toolRegistry: ToolRegistry,
  provider: LLMProvider,
  options: ResumeExecuteOptions
) => Promise<ExecutionResult>;

const toolCallScopes = new WeakMap<object, ToolCallScope>();

/** Binds `scope` to the options object a tool's `execute` is called with. */
export function bindToolCallScope(toolOptions: object, scope: ToolCallScope | undefined): void {
  if (scope) {
    toolCallScopes.set(toolOptions, scope);
  }
}

/** The tool call a tool's `execute` options belong to, when the executor started it. */
export function toolCallScopeOf(toolOptions: unknown): ToolCallScope | undefined {
  return typeof toolOptions === 'object' && toolOptions !== null ? toolCallScopes.get(toolOptions) : undefined;
}

/** Default `maxSubagentDepth`: sub-agents cannot start sub-agents of their own. */
const DEFAULT_MAX_SUBAGENT_DEPTH = 1;

/**
 * How many more levels of sub-agents a run may start. A sub-agent's run gets
 * its parent's budget minus one, so the top-level run's `maxSubagentDepth`
 * bounds the whole tree.
 */
export function subagentBudget(maxSubagentDepth: number | undefined): number {
  return maxSubagentDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH;
}

/**
 * Thrown by the delegation core when a child run paused for approval. The
 * executor turns it into a placeholder result for the calling tool call and
 * pauses the parent run once the turn's tool calls are done.
 */
export class SubagentApprovalPause extends PropagatingToolError {
  constructor(
    readonly agentName: string,
    readonly snapshot: ExecutionSnapshot
  ) {
    super(`Sub-agent '${agentName}' is waiting for approval of '${snapshot.pendingToolCall.toolName}'`);
    this.name = 'SubagentApprovalPause';
  }
}

/** The paused child call deepest in a chain of suspensions. */
function leafPending(snapshot: ExecutionSnapshot): PendingApproval {
  return snapshot.pendingToolCall;
}

/**
 * The tool result recorded for a tool call whose sub-agent paused. It is
 * replaced by the real result when the run is resumed.
 */
export function suspendedToolResult(suspension: SubagentSuspension): Record<string, unknown> {
  return {
    status: 'awaiting-approval',
    message: `Sub-agent '${suspension.agentName}' is waiting for a human to approve '${leafPending(suspension.snapshot).toolName}'. No result yet.`,
  };
}

/**
 * Builds the suspension record for a tool call whose sub-agent paused, from
 * the call and the args it ran with.
 */
export function toSuspension(
  pause: SubagentApprovalPause,
  call: Pick<SubagentSuspension, 'toolCallId' | 'toolName' | 'args'>
): SubagentSuspension {
  return {
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    args: call.args,
    agentName: pause.agentName,
    snapshot: pause.snapshot,
  };
}

/**
 * The pending approval saved for a run paused on a sub-agent: the child's
 * own pending call (so a reviewer sees what actually needs approving), with
 * the chain of sub-agent names it runs inside.
 */
function pendingForSuspension(suspension: SubagentSuspension): PendingApproval {
  const child = leafPending(suspension.snapshot);
  return { ...child, subagentPath: [suspension.agentName, ...(child.subagentPath ?? [])] };
}

/** The approval record that pauses a parent run on a suspended sub-agent. */
export function suspensionRecord(
  run: { agent: AgentConfig; sessionId?: string },
  state: { messages: Message[]; steps: number; usage: RunUsage; queuedInput?: Message[] },
  suspension: SubagentSuspension
): { pending: PendingApproval; snapshot: ExecutionSnapshot } {
  const pending = pendingForSuspension(suspension);
  return {
    pending,
    snapshot: {
      agent: baseAgentOf(run.agent),
      // LOU-U8: queued input rides at the end; resume moves it behind the results.
      currentMessages: [...state.messages, ...(state.queuedInput ?? [])],
      pendingToolCall: pending,
      steps: state.steps,
      sessionId: run.sessionId,
      usage: structuredClone(state.usage),
      subagent: suspension,
    },
  };
}

/**
 * Picks the suspended tool call (if any) the run pauses on after a turn: the
 * first in call order - or none when the turn already pauses on a tool that
 * needs approval itself. Only one approval can be pending per run, so the
 * result of every other suspended call is rewritten into an error saying its
 * sub-agent's call was never run (the sub-agent's paused state is dropped).
 */
export function settleSuspensions(
  messages: Message[],
  suspensions: readonly SubagentSuspension[],
  pausingForTool: boolean
): SubagentSuspension | undefined {
  const [first, ...rest] = suspensions;
  for (const dropped of pausingForTool ? suspensions : rest) {
    replaceToolResult(messages, {
      role: 'tool',
      content: JSON.stringify(
        toolErrorResult({ toolName: dropped.toolName, error: `Sub-agent '${dropped.agentName}' needed approval to run '${leafPending(dropped.snapshot).toolName}' while this run was already pausing for another approval, so that call was not run and the sub-agent stopped. Call it again once the pending approval is resolved.`, kind: 'not-run' })
      ),
      name: dropped.toolName,
      toolCallId: dropped.toolCallId,
      toolName: dropped.toolName,
      isError: true,
    });
  }
  return pausingForTool ? undefined : first;
}

/** Replaces the tool result recorded for `message.toolCallId`, or appends `message` when there is none. */
export function replaceToolResult(messages: Message[], message: Message): void {
  const index = messages.findIndex((m) => m.role === 'tool' && m.toolCallId === message.toolCallId);
  if (index === -1) {
    messages.push(message);
  } else {
    messages[index] = message;
  }
}

const baseAgents = new WeakMap<AgentConfig, AgentConfig>();

/**
 * Returns `agent` with `changes` applied, remembering the original so that
 * an approval snapshot stores the agent as the caller configured it (resume
 * re-applies skills and sub-agents itself).
 */
export function extendAgent(agent: AgentConfig, changes: Partial<AgentConfig>): AgentConfig {
  const extended = { ...agent, ...changes };
  baseAgents.set(extended, baseAgentOf(agent));
  return extended;
}

/** The agent as configured, before skills or sub-agents were applied. */
export function baseAgentOf(agent: AgentConfig): AgentConfig {
  return baseAgents.get(agent) ?? agent;
}
