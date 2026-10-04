/**
 * Tool-call execution for AgentExecutor's main loop: runs one LLM-requested
 * tool call with its observability callbacks (onToolCall/onToolResult),
 * pre/post tool-call hooks, approval check and sandbox routing.
 */

import { Message, ToolCall } from '../providers';
import { AgentConfig, ToolDescriptor, type ApprovalCheckContext, type ApprovalOutcome } from '../types';
import { ToolRegistry } from '../tools';
import { getToolExecute } from '../tools/toolContract';
import { SandboxAdapter } from '../security/sandboxCore';
import { executeToolWithSandboxGuard } from './sandboxGuard';
import type { ToolRunContext } from './toolRunContext';
import { HookRegistry, ToolCallHookContext, type PreToolCallDecision } from './hooks';
import { toolErrorMessage } from './propagatingToolError';
import { toolErrorResult, type ToolErrorKind } from './toolErrors';
import { ToolArgumentsValidationError, parseToolArguments, validateToolArguments } from './toolArgsValidation';
import {
  checkPermission,
  permissionModeOf,
  permissionModeVerdict,
  reportHookDenial,
  reportPermission,
  type PermissionDecisionEntry,
  type PermissionMode,
  type PermissionRuntime,
} from './permissions';
import { checkToolGuardrails } from './ioGuardrails';
import type { ExecuteOptions } from './AgentExecutor';
import { stableStringify } from '../testing/fingerprint';
import type { SubagentSuspension } from './ApprovalGate';
import { SubagentApprovalPause, suspendedToolResult, toSuspension, type ToolCallScope } from './subagentRuntime';
import type { Principal } from '../auth/types';
import { isSignInRequired, settleSignInRequired, type SignInRequired } from '../oauth/signIn';

export { parseToolArguments };

/**
 * Settled outcome of one tool call, as emitted in the 'tool-result' event
 * and handed to onToolResult.
 */
export interface ToolCallOutcome {
  toolCallId: string;
  toolName: string;
  result: unknown;
  error?: string;
  requiresApproval?: boolean;
  args?: Record<string, unknown>;
  /**
   * LOU-Y1: set when the tool started a sub-agent that paused for approval.
   * `result` is then a placeholder; the run pauses once the turn is done.
   */
  subagent?: SubagentSuspension;
  /** LOU-X3: the hook whose `{ result }` outcome became this call's result. */
  replacedByHook?: string;
  /**
   * N9b: set when the tool called `ctx.getToken()` without a usable token.
   * The call has no result; the run pauses for sign-in (`kind: 'sign-in'`)
   * once the batch is done, and the call runs again after the user signed in.
   */
  signIn?: SignInRequired;
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
  /** N10b: who the run acts for (frozen): reaches hooks, permission rules, `needsApproval` and the tool. */
  principal?: Readonly<Principal>;
  /** LOU-R16: the run's `ExecuteOptions.metadata`, handed to hooks as `ctx.metadata`. */
  metadata?: Record<string, unknown>;
  messages: Message[];
  /** LOU-V1: the run's signal, handed to the tool as `abortSignal`. */
  signal?: AbortSignal;
  /** LOU-Y1: this call, as seen by a sub-agent the tool starts. */
  scope?: ToolCallScope;
  /** LOU-V5: where a delegated child's usage is reported (see ToolRunContext). */
  onDelegatedUsage?: ToolRunContext['onDelegatedUsage'];
  /** N13b: a snapshot a generator tool yielded (reported as `tool.partial`); never part of the result. */
  onToolPartial?: (toolCallId: string, toolName: string, output: unknown) => void;
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
    ...(ctx.principal && { principal: ctx.principal }),
    metadata: ctx.metadata,
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

/**
 * Runs a tool call's gate (LOU-X3 order): onToolCall, argument validation,
 * pre-tool hooks (and their outcomes), permission rules, tool guardrails and
 * the `needsApproval` check. Hooks run before the approval decision, so a
 * human approves the arguments a hook produced.
 */
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

  // A `preToolCall` hook (e.g. redact-pii) may mutate `args` in place or
  // return an outcome (LOU-X3); the final args are what `needsApproval` and `execute` receive.
  const hooked = ctx.hooks
    ? await runPreToolHooks(ctx.hooks, toolHookContext(toolCall, ctx, checked.args), { toolRegistry: ctx.toolRegistry, runtime: ctx.scope?.runtime })
    : { args: checked.args };
  if (hooked.outcome) {
    return { toolCall, args: hooked.args, requiresApproval: false, rejection: hooked.outcome };
  }
  return gateToolCall(toolCall, ctx, hooked.args);
}

/** Permission rules, tool guardrails and `needsApproval`, on the hook-processed args. */
async function gateToolCall(toolCall: ToolCall, ctx: ToolCallContext, hookedArgs: Record<string, unknown>): Promise<PreparedToolCall> {
  // N4: the mode is read once per call, so a switch applies from the next call.
  const mode = ctx.scope ? permissionModeOf(ctx.scope.runtime) : 'default';
  // LOU-X2: a matching permission rule decides before `needsApproval` does.
  const { entry, gate: ruled } = await checkPermissionRules(toolCall, ctx, hookedArgs, mode);
  let audit = entry;
  try {
    if (ruled?.rejection) {
      return { toolCall, args: hookedArgs, requiresApproval: false, rejection: ruled.rejection };
    }
    // LOU-X4: tool guardrails run on calls that were not denied; a block throws GuardrailError.
    const args = ctx.scope
      ? await checkToolGuardrails(ctx.scope.runtime, { toolName: toolCall.function.name, args: hookedArgs, messages: ctx.messages })
      : hookedArgs;
    // LOU-X8 follow-up: an `allow` / `ask` rule replaces the tool's own ask, not its deny.
    const own = await checkNeedsApproval(toolCall, ctx, args);
    const { denied, ...gate } = own.rejection ? own : (ruled ?? own);
    // LOU-X8: the tool's own deny is audited like a rule's.
    if (denied && audit) audit = { ...audit, decision: 'deny', ...(denied.reason !== undefined && { reason: denied.reason }) };
    // N4: the permission mode applies last, to a call nothing above denied: it never turns a deny into a run.
    const moded = gate.rejection ? undefined : applyPermissionMode(mode, toolCall, ctx, gate.requiresApproval);
    if (moded && audit) audit = { ...audit, ...moded.audit };
    return { toolCall, args, ...(moded?.gate ?? gate) };
  } finally {
    if (audit && ctx.scope) reportPermission(ctx.scope.runtime, audit);
  }
}

/**
 * N4: what the run's permission mode does with a call that was not denied
 * (see `permissionModeVerdict()`): the new gate and the audit fields, or
 * undefined when the mode does not change the outcome.
 */
function applyPermissionMode(
  mode: PermissionMode,
  toolCall: ToolCall,
  ctx: ToolCallContext,
  requiresApproval: boolean
): { gate: ToolGate; audit: Pick<PermissionDecisionEntry, 'decision' | 'reason' | 'mode'> } | undefined {
  if (mode === 'default') return undefined;
  const tool = ctx.toolRegistry && findExecutableTool(ctx.toolRegistry, toolCall.function.name);
  const verdict = permissionModeVerdict(mode, tool, requiresApproval);
  if (!verdict) return undefined;
  if ('approve' in verdict) return { gate: { requiresApproval: false }, audit: { decision: 'allow', mode } };
  const { rejection } = deniedGate(toolCall, `${mode} mode`, verdict.deny);
  return { gate: { requiresApproval: false, rejection }, audit: { decision: 'deny', reason: verdict.deny, mode } };
}

/** The pre-tool hooks' verdict (LOU-X3): the final args, or the outcome that settles the call without running it. */
interface PreHookVerdict {
  args: Record<string, unknown>;
  outcome?: ToolCallOutcome;
}

/**
 * Runs the pre-tool hooks and applies their outcome (LOU-X3): a deny or a
 * result settles the call; hook-supplied input is validated against the
 * tool's schema again. `approvedArgs` (a resumed, approved call) refuses
 * hook input that differs from what the human approved.
 */
export async function runPreToolHooks(
  hooks: HookRegistry,
  hookCtx: ToolCallHookContext,
  opts: { toolRegistry?: ToolRegistry; runtime?: PermissionRuntime; approvedArgs?: Record<string, unknown> }
): Promise<PreHookVerdict> {
  const { stop, inputBy } = await hooks.runPreToolCall(hookCtx);
  const { toolCall, args } = hookCtx;
  if (stop) {
    return { args, outcome: hookStopOutcome(hookCtx, stop, opts.runtime) };
  }
  let final = args;
  if (inputBy.length > 0) {
    const checked = await checkToolArguments(toolCall, opts.toolRegistry, args);
    if (checked.rejection) {
      return { args, outcome: hookInputFailure(checked.rejection, inputBy, checked.rejection.error ?? '') };
    }
    final = checked.args;
  }
  // LOU-X3.2: whether a hook supplied the input or changed `ctx.args` in place,
  // the call runs with what the human approved (key order does not matter).
  if (opts.approvedArgs && stableStringify(final) !== stableStringify(opts.approvedArgs)) {
    return { args, outcome: hookInputFailure(toolFailure(toolCall, 'validation', ''), inputBy, 'the call was approved with different input') };
  }
  return { args: final };
}

/** The outcome of a call a pre-tool hook denied or answered (LOU-X3). */
function hookStopOutcome(hookCtx: ToolCallHookContext, stop: NonNullable<PreToolCallDecision['stop']>, runtime?: PermissionRuntime): ToolCallOutcome {
  const { toolCall, args, sessionId, principal } = hookCtx;
  if ('deny' in stop) {
    if (runtime) reportHookDenial(runtime, { toolName: toolCall.function.name, toolCallId: toolCall.id, sessionId, ...(principal && { principal }), args }, { hook: stop.hook, reason: stop.deny });
    return deniedGate(toolCall, `hook '${stop.hook}'`, stop.deny).rejection as ToolCallOutcome;
  }
  return { toolCallId: toolCall.id, toolName: toolCall.function.name, result: stop.result, replacedByHook: stop.hook };
}

/** A hook-caused validation error (LOU-X3): `failure`, with a message naming the hooks that supplied the input. */
function hookInputFailure(failure: ToolCallOutcome, hooks: string[], why: string): ToolCallOutcome {
  const names = hooks.length > 0 ? `hook ${hooks.map((name) => `'${name}'`).join(', ')}` : 'a hook changing the arguments in place';
  const error = `Input from ${names} for tool '${failure.toolName}' was refused: ${why}`;
  return { ...failure, error, result: { ...(failure.result as object), message: error, hook: hooks.at(-1) } };
}

/** The gate part of a {@link PreparedToolCall}; `denied` when the tool's `needsApproval` denied it (LOU-X8). */
type ToolGate = Pick<PreparedToolCall, 'rejection' | 'requiresApproval'> & { denied?: { reason?: string } };

/**
 * Applies the run's permission rules (LOU-X2, read from `ctx.scope.runtime`).
 * `gate` is undefined when no rule decided the call; a throwing `when`
 * becomes the call's error outcome, like a throwing `needsApproval`. `entry`
 * is the audit entry to report once the call is decided.
 */
async function checkPermissionRules(
  toolCall: ToolCall,
  ctx: ToolCallContext,
  args: Record<string, unknown>,
  mode: PermissionMode
): Promise<{ entry?: PermissionDecisionEntry; gate?: ToolGate }> {
  if (!ctx.scope) {
    return {};
  }
  const toolName = toolCall.function.name;
  try {
    const call = { toolName, toolCallId: toolCall.id, sessionId: ctx.sessionId, ...(ctx.principal && { principal: ctx.principal }), args };
    const entry = await checkPermission(ctx.scope.runtime, call, mode);
    if (entry?.decision === 'deny') {
      return { entry, gate: deniedGate(toolCall, 'a permission rule', entry.rule?.reason) };
    }
    const gate = entry?.decision === 'allow' || entry?.decision === 'ask' ? { requiresApproval: entry.decision === 'ask' } : undefined;
    return { entry, gate };
  } catch (error) {
    return { gate: { requiresApproval: false, rejection: thrownToolFailure(toolCall, error) } };
  }
}

/** A call refused by `by` (a permission rule or the tool's `needsApproval`): a `kind: 'denied'` tool error with `reason`. */
function deniedGate(toolCall: ToolCall, by: string, reason: string | undefined): ToolGate {
  const toolName = toolCall.function.name;
  const error = `Tool '${toolName}' was denied by ${by}${reason ? `: ${reason}` : ''}`;
  const result = toolErrorResult({ toolName, error, kind: 'denied', details: reason ? { reason } : undefined });
  return { requiresApproval: false, rejection: { ...toolFailure(toolCall, 'denied', error), result }, denied: { reason } };
}

/**
 * Resolves the called tool's `needsApproval`. A throwing `needsApproval`
 * becomes the call's error outcome (a `PropagatingToolError` is rethrown).
 */
async function checkNeedsApproval(
  toolCall: ToolCall,
  ctx: ToolCallContext,
  args: Record<string, unknown>
): Promise<ToolGate> {
  const toolDesc = ctx.toolRegistry && findExecutableTool(ctx.toolRegistry, toolCall.function.name);
  if (!toolDesc) {
    return { requiresApproval: false };
  }
  try {
    const check: ApprovalCheckContext = {
      toolName: toolCall.function.name,
      toolCallId: toolCall.id,
      sessionId: ctx.sessionId,
      messages: ctx.messages,
      ...(ctx.principal && { principal: ctx.principal }),
    };
    return approvalGate(toolCall, await resolveNeedsApproval(toolDesc, args, check));
  } catch (error) {
    return { requiresApproval: false, rejection: thrownToolFailure(toolCall, error) };
  }
}

/** LOU-X8: what a `needsApproval` outcome does with the call. */
function approvalGate(toolCall: ToolCall, outcome: ApprovalOutcome): ToolGate {
  if (outcome === 'deny' || (typeof outcome === 'object' && outcome !== null)) {
    return deniedGate(toolCall, 'its needsApproval policy', outcome === 'deny' ? undefined : outcome.deny);
  }
  return { requiresApproval: outcome === true || outcome === 'ask' };
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
      outcome = await runPostToolHooks(ctx.hooks, toolHookContext(toolCall, ctx, hookArgs), outcome);
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

/** Runs the post-tool hooks; a `{ result }` outcome replaces a settled call's result (LOU-X3). */
async function runPostToolHooks(hooks: HookRegistry, hookCtx: ToolCallHookContext, outcome: ToolCallOutcome): Promise<ToolCallOutcome> {
  // N9b: a call paused for sign-in is reported like one awaiting approval (no result yet).
  const payload = { result: outcome.result, error: outcome.error, requiresApproval: outcome.requiresApproval ?? (outcome.signIn ? true : undefined) };
  const hook = await hooks.runPostToolCall(hookCtx, payload);
  if (hook === undefined || outcome.requiresApproval || outcome.subagent || outcome.signIn) {
    return outcome;
  }
  return { ...outcome, result: payload.result, replacedByHook: hook };
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
  return doExecuteToolCall(prepared.toolCall, ctx, prepared.args);
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
      rejection: { ...toolFailure(toolCall, 'validation', error.message), result: error.toToolResult() },
    };
  }
}

/**
 * The error outcome for a tool call that could not produce a result (LOU-U14):
 * `error` keeps the plain message for events and hooks, `result` is the
 * structured {@link toolErrorResult} the model sees.
 */
function toolFailure(toolCall: ToolCall, kind: ToolErrorKind, error: string): ToolCallOutcome {
  return {
    toolCallId: toolCall.id,
    toolName: toolCall.function.name,
    result: toolErrorResult({ toolName: toolCall.function.name, error, kind }),
    error,
  };
}

/** Returns the named tool only if it has a directly callable `execute`. */
function findExecutableTool(
  toolRegistry: ToolRegistry,
  toolName: string
): ToolDescriptor | undefined {
  const toolDesc = toolRegistry.get(toolName);
  return toolDesc && getToolExecute(toolDesc) ? toolDesc : undefined;
}

/** Resolves a tool's static or per-call `needsApproval` setting. */
async function resolveNeedsApproval(
  toolDesc: ToolDescriptor,
  args: Record<string, unknown>,
  check: ApprovalCheckContext
): Promise<ApprovalOutcome> {
  return typeof toolDesc.needsApproval === 'function'
    ? await toolDesc.needsApproval(args, check)
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
 * `PropagatingToolError` are rethrown by toolErrorMessage() so they
 * propagate out of execute() as a rejected promise instead of becoming a
 * conversational {error} tool-result.
 * LOU-U12: the model gets a structured error (not the string "null"),
 * while `outcome.error` keeps the plain message for events/hooks.
 */
function thrownToolFailure(toolCall: ToolCall, error: unknown): ToolCallOutcome {
  return {
    ...toolFailure(toolCall, 'execution', toolErrorMessage(error)),
    result: toolErrorResult({ toolName: toolCall.function.name, error }),
  };
}

/**
 * Actual tool-execution logic, split out from runToolCall() so the
 * onToolCall/onToolResult hooks (LOU-E2) can wrap it uniformly via
 * try/finally regardless of which branch below returns or throws.
 */
async function doExecuteToolCall(
  toolCall: ToolCall,
  ctx: ToolCallContext,
  overrideArgs?: Record<string, unknown>
): Promise<ToolCallOutcome> {
  const { toolRegistry } = ctx;
  if (!toolRegistry) {
    return toolFailure(toolCall, 'not-found', 'No tool registry available');
  }

  try {
    const toolDesc = findExecutableTool(toolRegistry, toolCall.function.name);
    if (!toolDesc) {
      return toolFailure(toolCall, 'not-found', `Tool '${toolCall.function.name}' not found`);
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
      ctx.sandbox,
      ctx.signal,
      // LOU-U9: `toolCallId` is the tool's idempotency key on a re-run.
      // LOU-U15: `messages` is the run's transcript (the guard copies it).
      // LOU-D23.2: and the run's `sessionId`, when it has one. N10b: and its principal. N9b: and the token store.
      // N13b: and where a generator tool's snapshots go.
      {
        onDelegatedUsage: ctx.onDelegatedUsage,
        toolCallId: toolCall.id,
        messages: ctx.messages,
        sessionId: ctx.sessionId,
        principal: ctx.principal,
        tokens: ctx.scope?.runtime.tokens,
        ...(ctx.onToolPartial && { onPartial: partialReporter(ctx.onToolPartial, toolCall) }),
      },
      ctx.scope
    );

    return {
      toolCallId: toolCall.id,
      toolName: toolCall.function.name,
      result,
    };
  } catch (error) {
    if (error instanceof SubagentApprovalPause) {
      return suspendedOutcome(toolCall, overrideArgs ?? {}, error);
    }
    // N9b: checked by name before the error-to-result path, so the model never sees it as a tool error.
    if (isSignInRequired(error)) {
      return signInOutcome(toolCall, overrideArgs ?? {}, error, ctx);
    }
    return thrownToolFailure(toolCall, error);
  }
}

/** N13b: `report` bound to one call. */
function partialReporter(report: NonNullable<ToolCallContext['onToolPartial']>, toolCall: ToolCall): (output: unknown) => void {
  return (output) => report(toolCall.id, toolCall.function.name, output);
}

/**
 * N9b: a call whose tool needs the user to sign in: a pause (no result; the
 * executor pauses the run for it), or - for the app's own credential - an error.
 */
async function signInOutcome(toolCall: ToolCall, args: Record<string, unknown>, signal: SignInRequired, ctx: ToolCallContext): Promise<ToolCallOutcome> {
  const settled = await settleSignInRequired(signal, ctx.scope?.runtime.tokens);
  if ('error' in settled) return thrownToolFailure(toolCall, settled.error);
  return { toolCallId: toolCall.id, toolName: toolCall.function.name, result: null, args, signIn: settled.pause };
}

/** The outcome of a tool call whose sub-agent paused for approval. */
function suspendedOutcome(
  toolCall: ToolCall,
  args: Record<string, unknown>,
  pause: SubagentApprovalPause
): ToolCallOutcome {
  const subagent = toSuspension(pause, { toolCallId: toolCall.id, toolName: toolCall.function.name, args });
  return {
    toolCallId: toolCall.id,
    toolName: toolCall.function.name,
    result: suspendedToolResult(subagent),
    args,
    subagent,
  };
}
