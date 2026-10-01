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

import type { ToolExecutionOptions } from 'ai';
import { ToolDescriptor } from '../types';
import { SandboxAdapter } from '../security/sandboxCore';

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
 * - Otherwise (no `requiresSandbox`), calls `tool.execute(args, { abortSignal })`
 *   directly - the exact, unchanged pre-existing path - or resolves to
 *   `null` if the tool has no `execute` implementation at all.
 *
 * LOU-V1: `signal` (the run's cancellation signal) reaches the tool as
 * `abortSignal` - the option name the 'ai' SDK's own `tool()` execute
 * signature uses - in both branches.
 */
export async function executeToolWithSandboxGuard(
  toolName: string,
  toolDesc: ToolDescriptor,
  args: Record<string, unknown>,
  sandbox: SandboxAdapter,
  signal?: AbortSignal
): Promise<unknown> {
  if (toolDesc.requiresSandbox) {
    if (!toolDesc.sandboxExecute) {
      throw new Error(
        `Tool "${toolName}" is flagged requiresSandbox but does not implement sandboxExecute() ` +
          `- cannot be safely sandboxed, refusing to fall back to unsandboxed execution`
      );
    }
    return signal
      ? toolDesc.sandboxExecute(args, sandbox, { abortSignal: signal })
      : toolDesc.sandboxExecute(args, sandbox);
  }

  // The 'ai' SDK types toolCallId/messages as required, but tools invoked
  // here are not part of an 'ai' SDK generation, so only abortSignal is set.
  const executeOptions = { abortSignal: signal } as ToolExecutionOptions;
  return toolDesc.tool.execute ? toolDesc.tool.execute(args, executeOptions) : null;
}
