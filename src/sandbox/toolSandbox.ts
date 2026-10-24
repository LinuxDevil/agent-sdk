/**
 * The bridge between `defineTool({ sandbox })` and {@link sandbox}: a tool's
 * `execute` crosses the boundary as source text (a live closure cannot),
 * its args and the cloneable part of its `ctx` as structured clones, and
 * its result clones back.
 *
 * What the sandboxed `execute` sees:
 *
 * - `args`: the validated arguments, cloned.
 * - `ctx`: the cloneable subset `{ toolCallId, messages, sessionId,
 *   principal, approval }`. The non-cloneable members of
 *   `ToolExecutionContext` cannot cross: `abortSignal`, `getToken`,
 *   `requireAuth` and `onDelegatedUsage` are simply absent inside the box,
 *   so a tool that needs OAuth tokens or cancellation cannot be sandboxed
 *   this way.
 * - Globals: whatever the driver provides. The 'isolate' driver is a bare
 *   V8 context - ECMAScript builtins only, no `fetch`, `console`, `process`
 *   or host modules - so `execute` must be self-contained: every function or
 *   value it references must be declared inside its own source. A closure
 *   over host state fails inside the box as an ordinary tool error.
 *
 * What comes back is `execute`'s resolved value, cloned; what it threw
 * crosses back as a normal tool error (the model sees it). A boundary
 * failure crosses as a {@link SandboxError}.
 */

import { SDKError } from '../utils/sdkError';
import type { ToolExecutionContext } from '../types/tool';
import type { Sandbox } from './types';

/** `execute` as source text for the driver, or a defineTool-time failure when it cannot cross the boundary. */
export function toolSandboxSource(toolName: string, execute: unknown): string {
  if (typeof execute !== 'function') {
    throw new SDKError(`defineTool: tool '${toolName}' with 'sandbox' needs an 'execute' function`, 'LOUSHO_CONFIG_INVALID');
  }
  const ctor = (execute as { constructor?: { name?: unknown } }).constructor?.name;
  const source = Function.prototype.toString.call(execute).trim();
  if (
    ctor === 'GeneratorFunction' ||
    ctor === 'AsyncGeneratorFunction' ||
    /^(?:async\s+)?(?:function\s*)?\*/.test(source)
  ) {
    throw new SDKError(
      `defineTool: tool '${toolName}' cannot combine 'sandbox' with a generator 'execute' - a sandboxed run returns one value, not a stream`,
      'LOUSHO_CONFIG_INVALID'
    );
  }
  if (/{\s*\[native code\]\s*}/.test(source)) {
    throw new SDKError(
      `defineTool: tool '${toolName}' has an 'execute' that cannot be sandboxed (native or bound function - its source cannot cross the boundary)`,
      'LOUSHO_CONFIG_INVALID'
    );
  }
  // Object-method shorthand (`async execute(args) {`) does not evaluate as an
  // expression the way `function`/`async`/arrow forms do - give it the keyword.
  // The arrow forms `async (args) =>` and `x =>` are left alone (a method
  // literally named `async` is not supported).
  if (/^async\s+[A-Za-z_$][\w$]*\s*\(/.test(source)) return source.replace(/^async\s+/, 'async function ');
  if (/^(?!async\b)[A-Za-z_$][\w$]*\s*\(/.test(source)) return `function ${source}`;
  return source;
}

/**
 * The part of `ctx` that crosses the boundary by structured clone. A copy -
 * mutations inside the box do not reach the host object, and the live
 * members (`abortSignal`, `getToken`, `requireAuth`, `onDelegatedUsage`) are
 * left out.
 */
function sandboxableContext(ctx: ToolExecutionContext): Record<string, unknown> {
  return {
    toolCallId: ctx.toolCallId,
    messages: ctx.messages,
    ...(ctx.sessionId !== undefined && { sessionId: ctx.sessionId }),
    ...(ctx.principal !== undefined && { principal: ctx.principal }),
    ...(ctx.approval !== undefined && { approval: ctx.approval }),
  };
}

/** One sandboxed tool call: `execute` (as `source`) runs inside `box` with `[args, ctxSubset]`. */
export function runToolInSandbox(box: Sandbox, source: string, args: unknown, ctx: ToolExecutionContext): Promise<unknown> {
  return box.run(source, { args: [args, sandboxableContext(ctx)] });
}
