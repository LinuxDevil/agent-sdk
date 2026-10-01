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
import { toolErrorMessage, toolErrorResult } from './propagatingToolError';
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
  /** LOU-V1: the run's signal, handed to the tool as `abortSignal`. */
  signal?: AbortSignal;
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
 * A tool call that has passed its pre-execution gate - onToolCall, argument
 * validation, pre-tool hooks and the `needsApproval` check - but has not run.
 * LOU-V3: the executor gates the calls of a batch one at a time, in call
 * order, so it knows whether a call needs approval before it starts the next.
 */
export interface PreparedToolCall {
  toolCall: ToolCall;
  /** The validated (and possibly hook-mutated) arguments `execute` will get. */
  args: Record<string, unknown>;
  /** Set when the call must not execute (invalid args, or `needsApproval` threw). */
  rejection?: ToolCallOutcome;
  /** True when the call must wait for a human decision instead of running. */
  requiresApproval: boolean;
}

/**
 * Execute a tool call, wrapped in the onToolCall/onToolResult callbacks
 * and pre/post tool-call hooks. `onPrepared` (LOU-V3) is told the moment
 * the call has passed its gate (see {@link PreparedToolCall}), before it runs.
 */
export async function runToolCall(
  toolCall: ToolCall,
  ctx: ToolCallContext,
  onPrepared?: (prepared: PreparedToolCall) => void
): Promise<ToolCallOutcome> {
  const prepared = await prepareToolCall(toolCall, ctx);
  onPrepared?.(prepared);
  return settleToolCall(prepared, ctx);
}

/** Runs a tool call's gate: onToolCall, validation, pre-tool hooks, approval check. */
async function prepareToolCall(toolCall: ToolCall, ctx: ToolCallContext): Promise<PreparedToolCall> {
  if (ctx.onToolCall) {
    await ctx.onToolCall(toolCall);
  }

  // Parse args up front (best-effort) so hooks get a real object to
  // inspect/mutate. LOU-U4: the args are then validated against the tool's
  // schema FIRST, so pre-tool hooks, `needsApproval` and `execute` all see
  // the parsed (defaults/transforms applied) value. Invalid args skip the
  // pre-hooks and `execute`; the structured error flows through the normal
  // error-outcome path (post hook, onToolResult, events, tracing).
  const checked = await checkToolArguments(
    toolCall,
    ctx.toolRegistry,
    parseToolArguments(toolCall, {})
  );
  if (checked.rejection) {
    return { toolCall, args: checked.args, rejection: checked.rejection, requiresApproval: false };
  }

  // A `preToolCall` hook (e.g. redact-pii) may mutate `args` in place; that
  // same object is what `needsApproval` and `execute` receive.
  if (ctx.hooks) {
    await ctx.hooks.runPreToolCall(toolHookContext(toolCall, ctx, checked.args));
  }

  const approval = await checkNeedsApproval(toolCall, ctx.toolRegistry, checked.args);
  return { toolCall, args: checked.args, ...approval };
}

/**
 * Resolves the called tool's `needsApproval`. A throwing `needsApproval`
 * becomes the call's error outcome (a `PropagatingToolError` is rethrown).
 */
async function checkNeedsApproval(
  toolCall: ToolCall,
  toolRegistry: ToolRegistry | undefined,
  args: Record<string, unknown>
): Promise<Pick<PreparedToolCall, 'rejection' | 'requiresApproval'>> {
  const toolDesc = toolRegistry && findExecutableTool(toolRegistry, toolCall.function.name);
  if (!toolDesc) {
    return { requiresApproval: false };
  }
  try {
    return { requiresApproval: await resolveNeedsApproval(toolDesc, args) };
  } catch (error) {
    return { requiresApproval: false, rejection: thrownToolFailure(toolCall, error) };
  }
}

/**
 * Runs a prepared tool call (or settles it as rejected / awaiting approval),
 * followed by the post-tool hooks and onToolResult.
 */
async function settleToolCall(
  prepared: PreparedToolCall,
  ctx: ToolCallContext
): Promise<ToolCallOutcome> {
  const { toolCall, args: hookArgs } = prepared;
  const toolStart = Date.now();
  let outcome: ToolCallOutcome | undefined;
  let thrown: unknown;

  try {
    outcome = await executePrepared(prepared, ctx);
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

/** The outcome of a prepared call: its rejection, its approval pause, or its actual run. */
async function executePrepared(
  prepared: PreparedToolCall,
  ctx: ToolCallContext
): Promise<ToolCallOutcome> {
  if (prepared.rejection) {
    return prepared.rejection;
  }
  if (prepared.requiresApproval) {
    return approvalOutcome(prepared);
  }
  return doExecuteToolCall(prepared.toolCall, ctx.toolRegistry, ctx.sandbox, prepared.args, ctx.signal);
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

/** The outcome of a call that is paused for a human approval decision. */
function approvalOutcome(prepared: PreparedToolCall): ToolCallOutcome {
  return {
    toolCallId: prepared.toolCall.id,
    toolName: prepared.toolCall.function.name,
    result: null,
    requiresApproval: true,
    args: prepared.args,
  };
}

/**
 * The outcome for a thrown tool error. Errors that mark themselves as
 * `PropagatingToolError` (e.g. DelegationDepthExceededError) are rethrown
 * by toolErrorMessage() so they propagate out of execute() as a rejected
 * promise instead of becoming a conversational {error} tool-result.
 * LOU-U12: the model gets a structured error (not the string "null"),
 * while `outcome.error` keeps the plain message for events/hooks.
 */
function thrownToolFailure(toolCall: ToolCall, error: unknown): ToolCallOutcome {
  return {
    ...toolFailure(toolCall, toolErrorMessage(error)),
    result: toolErrorResult(toolCall.function.name, error),
  };
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
  overrideArgs?: Record<string, unknown>,
  signal?: AbortSignal
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
    // prepareToolCall() before preToolCall hooks ran - using it here
    // instead of re-parsing `toolCall.function.arguments` is what makes a
    // `preToolCall` hook (e.g. redact-pii) that mutates `ctx.args`
    // actually affect what the tool is invoked with.
    const args = overrideArgs ?? JSON.parse(toolCall.function.arguments);

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
      sandbox,
      signal,
      toolCall.id
    );

    return {
      toolCallId: toolCall.id,
      toolName: toolCall.function.name,
      result,
    };
  } catch (error) {
    return thrownToolFailure(toolCall, error);
  }
}
