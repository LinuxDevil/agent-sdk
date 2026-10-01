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

const propagatingErrors = new WeakSet<object>();

/**
 * Makes an error that is not a {@link PropagatingToolError} propagate like
 * one - used for a hook error thrown inside a sub-agent (LOU-Y1), which must
 * halt the whole run, not become the sub-agent tool's error result.
 */
export function markPropagating(error: unknown): void {
  if (typeof error === 'object' && error !== null) {
    propagatingErrors.add(error);
  }
}

/** Whether a thrown tool error must propagate out of execute() instead of becoming a tool result. */
export function isPropagatingToolError(error: unknown): boolean {
  return (
    error instanceof PropagatingToolError ||
    (typeof error === 'object' && error !== null && propagatingErrors.has(error))
  );
}

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
  if (isPropagatingToolError(error)) {
    throw error;
  }
  return (error as Error | undefined)?.message ?? String(error);
}
