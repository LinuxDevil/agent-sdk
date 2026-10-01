/**
 * Shared sandbox-routing guard for tool invocation (LOU-F fix).
 *
 * Both AgentExecutor.executeToolCall() and FlowExecutor.executeToolCall()
 * invoke arbitrary ToolDescriptors, and both need to honor
 * `ToolDescriptor.requiresSandbox` the same way: route through the tool's
 * `sandboxExecute()` when present, or fail closed instead of silently
 * falling back to unsandboxed in-process execution. That branching used to
 * live only inside AgentExecutor (LOU-F5), which meant a second entry point
 * (FlowExecutor's tool-call node, and separately resume.ts's post-approval
 * tool execution) could - and did - invoke `tool.execute()` directly with
 * no sandbox check at all, silently reproducing the exact bug LOU-F5 fixed.
 *
 * Factoring the check into this single helper means there is now only one
 * place this seam can be implemented, so it can't drift out of sync across
 * call sites again. Every tool-invocation call site in this codebase
 * (AgentExecutor.ts, FlowExecutor.ts, resume.ts) should route through this
 * function rather than calling `toolDesc.tool.execute()` directly.
 */

import { ToolDescriptor } from '../types';
import { getToolExecute } from '../tools/toolContract';
import { SandboxAdapter } from '../security/sandboxCore';
import type { ToolCallScope } from './subagentRuntime';
import { buildToolRunContext, type ToolRunInput } from './toolRunContext';

/**
 * Thrown when a `requiresSandbox` tool cannot be sandboxed (LOU-U14: reaches
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
 * LOU-U15: both branches hand the tool the same context, built by
 * buildToolRunContext(): `toolCallId`, `messages` (the transcript before
 * this call), `abortSignal` (LOU-V1, the run's cancellation signal) and the
 * SDK's own run fields.
 */
export async function executeToolWithSandboxGuard(
  toolName: string,
  toolDesc: ToolDescriptor,
  args: Record<string, unknown>,
  sandbox: SandboxAdapter,
  signal?: AbortSignal,
  runContext?: Omit<ToolRunInput, 'signal' | 'scope'>,
  scope?: ToolCallScope
): Promise<unknown> {
  // LOU-U15: one context for both routes (toolCallId, messages, abortSignal).
  const ctx = buildToolRunContext({ ...runContext, signal, scope });
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
  return execute ? execute(args, ctx) : null;
}
