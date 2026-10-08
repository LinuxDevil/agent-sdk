/**
 * A8: the gate a flow's `toolCall` step passes before its tool runs - the
 * same checks an agent run applies to a model's tool call: argument
 * validation against the tool's schema, permission rules and modes, and the
 * tool's `needsApproval`. A flow cannot pause, so a call that needs approval
 * is decided by the context's `approve` callback, or refused (fail closed)
 * when there is none.
 */

import type { ToolCall } from '../providers';
import type { ToolDescriptor } from '../types';
import { NoopSandbox } from '../security/sandboxCore';
import { SDKError } from '../execution/errors';
import { validateToolArguments } from '../execution/toolArgsValidation';
import { gateToolCall, type ToolCallContext } from '../execution/toolCallExecution';
import type { ToolCallScope } from '../execution/subagentRuntime';
import type { FlowExecutionContext } from './FlowExecutor';

/**
 * Validates and gates one `toolCall` step. Returns the arguments the tool
 * runs with (parsed by its schema); throws when the call must not run:
 * `LOUSHO_TOOL_ARGS_INVALID` for arguments that do not match the schema,
 * `LOUSHO_FLOW_TOOL_DENIED` for a denied call or one that needs approval
 * nobody gave.
 */
export async function gateFlowToolCall(
  toolName: string,
  toolDesc: ToolDescriptor,
  rawArgs: Record<string, unknown>,
  context: FlowExecutionContext,
  toolCallId: string
): Promise<Record<string, unknown>> {
  const args = (await validateToolArguments(toolName, toolDesc, rawArgs)) as Record<string, unknown>;
  const toolCall: ToolCall = { id: toolCallId, type: 'function', function: { name: toolName, arguments: safeJson(args) } };
  const prepared = await gateToolCall(toolCall, gateContext(context, toolCallId), args);
  if (prepared.rejection) {
    const { error, result } = prepared.rejection;
    const denied = (result as { kind?: unknown } | null)?.kind === 'denied';
    throw new SDKError(error ?? `Tool '${toolName}' was refused`, denied ? 'LOUSHO_FLOW_TOOL_DENIED' : 'LOUSHO_TOOL_EXECUTION_FAILED');
  }
  if (prepared.requiresApproval) {
    await requireApproval(toolName, toolCallId, prepared.args, context);
  }
  return prepared.args;
}

/** The tool-call context the shared gate reads: the flow's permission options as the run's runtime. */
function gateContext(context: FlowExecutionContext, toolCallId: string): ToolCallContext {
  const { permissions, permissionMode, onPermissionDecision, redactContent } = context;
  const scope: ToolCallScope = {
    runtime: { permissions, permissionMode, onPermissionDecision, redactContent },
    toolCallId,
    // The gate never starts a sub-agent; the tool itself runs outside it.
    execute: () => Promise.reject(new SDKError('A flow tool gate cannot start a sub-agent', 'LOUSHO_FLOW_EXECUTION_FAILED')),
  };
  return {
    agent: context.agent,
    toolRegistry: context.toolRegistry,
    sandbox: context.sandbox ?? NoopSandbox,
    messages: [],
    scope,
  };
}

/**
 * Asks the context's `approve` callback about a call that needs approval.
 * `true` (or a note) runs it; `false`, `'defer'` (a flow cannot pause) or no
 * callback at all refuses it.
 */
async function requireApproval(
  toolName: string,
  toolCallId: string,
  args: Record<string, unknown>,
  context: FlowExecutionContext
): Promise<void> {
  if (!context.approve) {
    throw new SDKError(
      `Tool '${toolName}' needs approval, and the flow has no approve callback, so it was not run. ` +
        `Pass approve in the flow context, e.g. FlowExecutor.execute(flow, { ...context, approve: ({ toolName, args }) => ... })`,
      'LOUSHO_FLOW_TOOL_DENIED'
    );
  }
  const verdict = await context.approve({
    id: toolCallId,
    toolCallId,
    toolName,
    args,
    ...(context.agent.id !== undefined && { agentId: context.agent.id }),
    createdAt: new Date().toISOString(),
  });
  if (verdict === true || (typeof verdict === 'string' && verdict !== 'defer')) return;
  const why = verdict === 'defer' ? `approve returned 'defer', and a flow cannot pause for a decision` : 'approve rejected the call';
  throw new SDKError(`Tool '${toolName}' was not run: ${why}`, 'LOUSHO_FLOW_TOOL_DENIED');
}

/** The arguments as JSON for the gate's `ToolCall` (it only labels the call). */
function safeJson(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args);
  } catch {
    return '{}';
  }
}
