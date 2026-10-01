/**
 * Tool-call execution for AgentExecutor's main loop: runs one LLM-requested
 * tool call with its observability callbacks (onToolCall/onToolResult),
 * pre/post tool-call hooks, approval check and sandbox routing.
 */

import { Message, ToolCall } from '../providers';
import { AgentConfig, ToolDescriptor } from '../types';
import { ToolRegistry } from '../tools';
import { SandboxAdapter } from '../security/sandboxCore';
import { executeToolWithSandboxGuard } from './sandboxGuard';
import { HookRegistry, ToolCallHookContext } from './hooks';
import { toolErrorMessage } from './propagatingToolError';
import { ToolArgumentsValidationError, validateToolArguments } from './toolArgsValidation';
import type { ExecuteOptions } from './AgentExecutor';

/**
 * Settled outcome of one tool call, as emitted in the 'tool-result' event
 * and handed to onToolResult.
 */
export interface ToolCallOutcome {
  toolCallId: string;
  toolName: string;
  result: any;
  error?: string;
  requiresApproval?: boolean;
  args?: Record<string, unknown>;
}

/** Everything a tool call needs from the surrounding execute() run. */
export interface ToolCallContext {
  agent: AgentConfig;
  toolRegistry?: ToolRegistry;
  onToolCall?: ExecuteOptions['onToolCall'];
  onToolResult?: ExecuteOptions['onToolResult'];
  sandbox: SandboxAdapter;
  hooks?: HookRegistry;
  sessionId?: string;
  messages: Message[];
}

/**
 * Best-effort parse of a tool call's JSON `arguments`, returning
 * `fallback` when they are not valid JSON.
 */
export function parseToolArguments(toolCall: ToolCall, fallback: unknown): unknown {
  try {
    return JSON.parse(toolCall.function.arguments);
  } catch {
    return fallback;
  }
}

/**
 * Builds the context object passed to a pre/post tool-call hook. Called
 * once per hook invocation so each receives its own object (sharing only
 * the mutable `args`).
 */
function toolHookContext(
  toolCall: ToolCall,
  ctx: ToolCallContext,
  args: Record<string, unknown>
): ToolCallHookContext {
  return {
    agentId: ctx.agent.id,
    agentName: ctx.agent.name,
    sessionId: ctx.sessionId,
    messages: ctx.messages,
    toolCallId: toolCall.id,
    toolName: toolCall.function.name,
    args,
    toolCall,
  };
}

/**
 * Execute a tool call, wrapped in the onToolCall/onToolResult callbacks
 * and pre/post tool-call hooks.
 */
export async function runToolCall(
  toolCall: ToolCall,
  ctx: ToolCallContext
): Promise<ToolCallOutcome> {
  if (ctx.onToolCall) {
    await ctx.onToolCall(toolCall);
  }

  // Parse args up front (best-effort) so hooks get a real object to
  // inspect/mutate even before doExecuteToolCall() parses them again for
  // its own use (needsApproval/execute). A hook mutating this object has
  // no effect on the actual call in this fallback case; see the
  // `hooks.runPreToolCall` call below for the real, load-bearing parse.
  //
  // LOU-U4: the args are then validated against the tool's schema FIRST,
  // so pre-tool hooks, `needsApproval` and `execute` all see the parsed
  // (defaults/transforms applied) value. Invalid args skip the pre-hooks
  // and `execute`; the structured error flows through the normal
  // error-outcome path (post hook, onToolResult, events, tracing).
  const checked = await checkToolArguments(
    toolCall,
    ctx.toolRegistry,
    parseToolArguments(toolCall, {})
  );
  const hookArgs = checked.args;

  if (ctx.hooks && !checked.rejection) {
    await ctx.hooks.runPreToolCall(toolHookContext(toolCall, ctx, hookArgs));
  }

  const toolStart = Date.now();
  let outcome: ToolCallOutcome | undefined;
  let thrown: unknown;

  try {
    outcome =
      checked.rejection ??
      (await doExecuteToolCall(toolCall, ctx.toolRegistry, ctx.sandbox, hookArgs));
    if (ctx.hooks) {
      await ctx.hooks.runPostToolCall(toolHookContext(toolCall, ctx, hookArgs), {
        result: outcome.result,
        error: outcome.error,
        requiresApproval: outcome.requiresApproval,
      });
    }
    return outcome;
  } catch (error) {
    thrown = error;
    throw error;
  } finally {
    const latencyMs = Date.now() - toolStart;
    if (ctx.onToolResult) {
      await ctx.onToolResult(toolCall, outcome, latencyMs, thrown);
    }
  }
}

/**
 * Validates `rawArgs` against the called tool's schema. Returns the parsed
 * args, or a `rejection` outcome (structured error as `result`, message as
 * `error`) when they do not match. Unknown/non-executable tools and tools
 * without a zod schema pass through for the normal path to handle.
 */
async function checkToolArguments(
  toolCall: ToolCall,
  toolRegistry: ToolRegistry | undefined,
  rawArgs: unknown
): Promise<{ args: Record<string, unknown>; rejection?: ToolCallOutcome }> {
  const toolName = toolCall.function.name;
  const toolDesc = toolRegistry && findExecutableTool(toolRegistry, toolName);
  if (!toolDesc) {
    return { args: rawArgs as Record<string, unknown> };
  }
  try {
    const parsed = await validateToolArguments(toolName, toolDesc, rawArgs);
    return { args: parsed as Record<string, unknown> };
  } catch (error) {
    if (!(error instanceof ToolArgumentsValidationError)) {
      throw error;
    }
    return {
      args: rawArgs as Record<string, unknown>,
      rejection: { ...toolFailure(toolCall, error.message), result: error.toToolResult() },
    };
  }
}

/** The `{error}` outcome for a tool call that could not produce a result. */
function toolFailure(toolCall: ToolCall, error: string): ToolCallOutcome {
  return {
    toolCallId: toolCall.id,
    toolName: toolCall.function.name,
    result: null,
    error,
  };
}

/** Returns the named tool only if it has a directly callable `execute`. */
function findExecutableTool(
  toolRegistry: ToolRegistry,
  toolName: string
): ToolDescriptor | undefined {
  const toolDesc = toolRegistry.get(toolName);
  return toolDesc?.tool?.execute ? toolDesc : undefined;
}

/** Resolves a tool's static or per-call `needsApproval` setting. */
async function resolveNeedsApproval(
  toolDesc: ToolDescriptor,
  args: Record<string, unknown>
): Promise<boolean> {
  return typeof toolDesc.needsApproval === 'function'
    ? await toolDesc.needsApproval(args)
    : !!toolDesc.needsApproval;
}

/**
 * Actual tool-execution logic, split out from runToolCall() so the
 * onToolCall/onToolResult hooks (LOU-E2) can wrap it uniformly via
 * try/finally regardless of which branch below returns or throws.
 */
async function doExecuteToolCall(
  toolCall: ToolCall,
  toolRegistry: ToolRegistry | undefined,
  sandbox: SandboxAdapter,
  overrideArgs?: Record<string, unknown>
): Promise<ToolCallOutcome> {
  if (!toolRegistry) {
    return toolFailure(toolCall, 'No tool registry available');
  }

  try {
    const toolDesc = findExecutableTool(toolRegistry, toolCall.function.name);
    if (!toolDesc) {
      return toolFailure(toolCall, `Tool '${toolCall.function.name}' not found`);
    }

    // `overrideArgs` is the (possibly hook-mutated) object built by
    // runToolCall() before preToolCall hooks ran - using it here
    // instead of re-parsing `toolCall.function.arguments` is what makes a
    // `preToolCall` hook (e.g. redact-pii) that mutates `ctx.args`
    // actually affect what the tool is invoked with.
    const args = overrideArgs ?? JSON.parse(toolCall.function.arguments);

    if (await resolveNeedsApproval(toolDesc, args)) {
      return {
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        result: null,
        requiresApproval: true,
        args,
      };
    }

    // The 'ai' SDK tool.execute expects (args, context). Tools flagged
    // `requiresSandbox` (LOU-F5) are routed through the configured
    // SandboxAdapter instead of being invoked directly here; a tool
    // WITHOUT the flag takes this exact, unchanged branch. This
    // branching now lives in the shared executeToolWithSandboxGuard()
    // helper (LOU-F fix) so FlowExecutor.ts and resume.ts share the
    // exact same fail-closed behavior instead of each reimplementing it.
    const result = await executeToolWithSandboxGuard(
      toolCall.function.name,
      toolDesc,
      args,
      sandbox
    );

    return {
      toolCallId: toolCall.id,
      toolName: toolCall.function.name,
      result,
    };
  } catch (error) {
    // Errors that mark themselves as `PropagatingToolError` (e.g.
    // DelegationDepthExceededError) are rethrown by toolErrorMessage() so
    // they propagate out of execute() as a rejected promise instead of
    // becoming a conversational {error} tool-result.
    return toolFailure(toolCall, toolErrorMessage(error));
  }
}
