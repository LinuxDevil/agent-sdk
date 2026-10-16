/**
 * Shared sandbox-routing guard for tool invocation.
 *
 * Both AgentExecutor.executeToolCall() and FlowExecutor.executeToolCall()
 * invoke arbitrary ToolDescriptors, and both need to honor
 * `ToolDescriptor.requiresSandbox` the same way: route through the tool's
 * `sandboxExecute()` when present, or fail closed instead of silently
 * falling back to unsandboxed in-process execution. That branching used to
 * live only inside AgentExecutor, which meant a second entry point
 * (FlowExecutor's tool-call node, and separately resume.ts's post-approval
 * tool execution) could - and did - invoke `tool.execute()` directly with
 * no sandbox check at all, silently reproducing the exact bug fixed.
 *
 * Factoring the check into this single helper means there is now only one
 * place this seam can be implemented, so it can't drift out of sync across
 * call sites again. Every tool-invocation call site in this codebase
 * (AgentExecutor.ts, FlowExecutor.ts, resume.ts) should route through this
 * function rather than calling `toolDesc.tool.execute()` directly.
 */

import { ToolDescriptor, type ToolExecutionContext } from '../types';
import { redactHandedOutError, redactHandedOutTokens } from '../oauth/signIn';
import { getToolExecute } from '../tools/toolContract';
import { SandboxAdapter } from '../security/sandboxCore';
import type { ToolCallScope } from './subagentRuntime';
import { buildToolRunContext, type ToolRunInput } from './toolRunContext';
import { normalizeToolResult } from './toolResult';
import { drainPartialStream, isPartialStream } from './toolPartials';

/**
 * Thrown when a `requiresSandbox` tool cannot be sandboxed (reaches
 * the model as an error result of `kind: 'sandbox'`).
 */
class SandboxRequiredError extends Error {
  readonly toolErrorKind = 'sandbox' as const;

  constructor(message: string) {
    super(message);
    this.name = 'SandboxRequiredError';
  }
}

export type { ToolRunContext } from './toolRunContext';

/**
 * Execute `toolDesc` against `args`, honoring `requiresSandbox`:
 *
 * - If `toolDesc.requiresSandbox` is true and `toolDesc.sandboxExecute` is
 *   implemented, calls it with `(args, sandbox)` and returns its result -
 *   `tool.execute()` (the unsandboxed in-process closure) is never invoked.
 * - If `toolDesc.requiresSandbox` is true and `toolDesc.sandboxExecute` is
 *   NOT implemented, there is no safe way to honor the flag: falling back
 *   to `tool.execute()` would run the tool's real code unsandboxed on the
 *   host while claiming it was isolated. So this fails closed and throws,
 *   matching this codebase's established fail-closed philosophy.
 * - Otherwise (no `requiresSandbox`), calls `tool.execute(args, ctx)`
 *   directly - or resolves to `null` if the tool has no `execute`
 *   implementation at all.
 *
 * Both branches hand the tool the same context, built by
 * buildToolRunContext(): `toolCallId`, `messages` (the transcript before
 * this call), `abortSignal` (the run's cancellation signal) and the
 * SDK's own run fields.
 *
 * When `execute` returns an async generator (see isPartialStream()),
 * every snapshot it yields goes to `runContext.onPartial` and the last one is
 * the result; the call lasts until the generator ends. The `sandboxExecute`
 * route does not stream.
 */
export async function executeToolWithSandboxGuard(
  toolName: string,
  toolDesc: ToolDescriptor,
  args: Record<string, unknown>,
  sandbox: SandboxAdapter,
  signal?: AbortSignal,
  runContext?: Omit<ToolRunInput, 'signal' | 'scope' | 'handedOut'>,
  scope?: ToolCallScope
): Promise<unknown> {
  // One context for both routes (toolCallId, messages, abortSignal).
  // Tokens `ctx.getToken()` hands out are remembered, so a result that echoes one is redacted.
  const handedOut = new Set<string>();
  const { onPartial, ...input } = runContext ?? {};
  const ctx = buildToolRunContext({ ...input, signal, scope, handedOut });
  const redacted = (value: unknown) => (handedOut.size > 0 ? redactHandedOutTokens(toolName, value, handedOut) : value);
  // A snapshot is redacted like the result it may become.
  let result: unknown;
  try {
    result = await runGuarded(toolName, toolDesc, args, sandbox, ctx, (snapshot) => onPartial?.(redacted(snapshot)));
  } catch (error) {
    // A thrown error becomes the call's error result, so it is redacted too.
    throw handedOut.size > 0 ? redactHandedOutError(toolName, error, handedOut) : error;
  }
  return normalizeToolResult(redacted(result));
}

async function runGuarded(
  toolName: string,
  toolDesc: ToolDescriptor,
  args: Record<string, unknown>,
  sandbox: SandboxAdapter,
  ctx: ToolExecutionContext,
  onPartial: (snapshot: unknown) => void
): Promise<unknown> {
  if (toolDesc.requiresSandbox) {
    if (!toolDesc.sandboxExecute) {
      throw new SandboxRequiredError(
        `Tool "${toolName}" is flagged requiresSandbox but does not implement sandboxExecute() ` +
          `- cannot be safely sandboxed, refusing to fall back to unsandboxed execution`
      );
    }
    return toolDesc.sandboxExecute(args, sandbox, ctx);
  }

  const execute = getToolExecute(toolDesc);
  if (!execute) return null;
  // A generator `execute` streams snapshots; its last one is the result. The whole run counts as the call.
  const returned = await execute(args, ctx);
  return isPartialStream(returned) ? drainPartialStream(returned, onPartial, ctx.abortSignal) : returned;
}
