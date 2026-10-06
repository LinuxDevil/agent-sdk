/**
 * `testToolContext()` - a `ToolExecutionContext` test double.
 *
 * Calling a tool's `execute(args, ctx)` directly in a unit test needs the
 * whole `ToolExecutionContext`, most of which (the OAuth methods above all)
 * the tool under test never touches. `testToolContext()` returns a valid
 * minimal context whose every field is overridable.
 */

import type { ToolExecutionContext } from '../types/tool';

function unstubbed(field: 'getToken' | 'requireAuth'): Error {
  return new Error(`testToolContext: ctx.${field}() is not stubbed - pass it in the overrides if the tool needs OAuth`);
}

/**
 * A minimal, valid {@link ToolExecutionContext} for calling
 * `tool.execute(args, ctx)` in a unit test.
 *
 * Defaults: `toolCallId` is `'test-call'`, `messages` is empty, and the
 * OAuth methods (`getToken`, `requireAuth`) fail loudly, so a tool that
 * unexpectedly asks for a token errors descriptively instead of silently
 * passing. Every field can be replaced through `overrides`.
 *
 * @example
 * ```ts
 * const tool = defineTool({ name: 'search', input: schema, execute: ... });
 * const hits = await tool.execute({ query: 'cats' }, testToolContext());
 * await tool.execute(args, testToolContext({ abortSignal: controller.signal }));
 * ```
 */
export function testToolContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    toolCallId: 'test-call',
    messages: [],
    getToken: () => Promise.reject(unstubbed('getToken')),
    requireAuth: () => {
      throw unstubbed('requireAuth');
    },
    ...overrides,
  };
}
