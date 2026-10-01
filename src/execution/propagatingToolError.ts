/**
 * Base class for tool errors that must NOT be swallowed by
 * executeToolCall()'s catch-all and converted into a conversational
 * `{error: ...}` tool-result message fed back to the LLM. Instead they
 * should propagate up out of execute() as a rejected promise, terminating
 * the run and giving the caller (which may itself be a parent delegate
 * tool's execute(), see DelegationTool.ts) an unambiguous signal.
 *
 * DelegationTool.ts's DelegationDepthExceededError extends this so that a
 * runaway delegation cycle (A -> B -> A -> ...) is stopped dead the moment
 * any one level's maxDepth guard fires, rather than having that error
 * re-enter the conversation as tool output that prompts the LLM to retry
 * the delegation - which is what let the original bug grow unbounded
 * (O(maxSteps^maxDepth) LLM calls) instead of failing fast.
 *
 * This lives in its own leaf module (re-exported from AgentExecutor.ts,
 * its public home) rather than in DelegationTool.ts because
 * DelegationTool.ts already imports AgentExecutor; having the executor's
 * tool-call path import back from DelegationTool.ts would be a circular
 * import. Defining the shared marker in this lower-level file lets every
 * direction work without a cycle.
 */
export class PropagatingToolError extends Error {}

/**
 * Converts a thrown tool error into the message string used for the
 * conversational `{error}` tool-result - EXCEPT for a
 * `PropagatingToolError` (e.g. DelegationDepthExceededError), which is
 * rethrown instead. Converting that one into a tool-result would hand the
 * LLM exactly the kind of "your tool call failed, try again" signal that
 * triggers another delegation attempt, defeating the whole point of the
 * depth guard. Shared by AgentExecutor's tool-call path and resume.ts's
 * deferred, post-approval tool execution so both handle it identically.
 */
export function toolErrorMessage(error: unknown): string {
  if (error instanceof PropagatingToolError) {
    throw error;
  }
  return (error as Error | undefined)?.message ?? String(error);
}

/** Max characters of an error message sent to the model (see {@link toolErrorResult}). */
const MAX_TOOL_ERROR_MESSAGE_LENGTH = 2000;

/**
 * The structured tool result the model sees when a tool's `execute` throws
 * (mirrors `ToolArgumentsValidationError.toToolResult()`, minus `issues`).
 *
 * @example
 * ```ts
 * // execute: async () => { throw new TypeError('bad input') }
 * // tool result the model sees:
 * // { error: 'TypeError', toolName: 'search', message: 'bad input' }
 * ```
 */
interface ToolErrorResult {
  /** The thrown error's `name` (`'Error'`, `'TypeError'`, ...). */
  error: string;
  toolName: string;
  /** The error message only (never a stack), truncated to 2,000 characters. */
  message: string;
}

/**
 * Builds the {@link ToolErrorResult} for a thrown tool error. Only the name
 * and (length-capped) message are exposed - never the stack - so a huge or
 * sensitive error cannot blow the context window.
 */
export function toolErrorResult(toolName: string, error: unknown): ToolErrorResult {
  const err = error as { name?: unknown; message?: unknown } | null | undefined;
  const raw = typeof err?.message === 'string' ? err.message : String(error);
  const message =
    raw.length > MAX_TOOL_ERROR_MESSAGE_LENGTH
      ? `${raw.slice(0, MAX_TOOL_ERROR_MESSAGE_LENGTH)}... (truncated)`
      : raw;
  return {
    error: typeof err?.name === 'string' && err.name ? err.name : 'Error',
    toolName,
    message,
  };
}
