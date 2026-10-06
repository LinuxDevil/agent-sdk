/**
 * LOU-341: a tool that returns nothing (`undefined`, an async generator that
 * yields nothing, a value `JSON.stringify` drops such as a function) has the
 * result `null`. Without this, `JSON.stringify(undefined)` is `undefined` and
 * the transcript gets a `tool` message with `content: undefined`, which
 * providers reject and a session store or checkpoint cannot round-trip.
 */
import type { Message, ToolCall } from '../providers';
import type { ToolCallOutcome } from './toolCallExecution';

/** A tool's result with "nothing" normalised to `null`. */
export function normalizeToolResult(result: unknown): unknown {
  return result === undefined ? null : result;
}

/** The `content` of a `tool` message for `result`: always a JSON string (`'null'` for nothing). */
export function toolResultContent(result: unknown): string {
  return JSON.stringify(normalizeToolResult(result)) ?? 'null';
}

/**
 * The `tool` message a settled call leaves on the transcript. A failed tool
 * carries `{error}` as its content - `result` is null then, so the model
 * would otherwise see a bare "null" and never learn the call failed; a
 * failure that already has a structured result (argument validation) keeps
 * it. A hook-replaced result is recorded under `metadata.replacedByHook`.
 */
export function toolOutcomeMessage(toolCall: ToolCall, outcome: ToolCallOutcome): Message {
  const failed = outcome.error !== undefined;
  const failurePayload = outcome.result ?? { error: outcome.error };
  return {
    role: 'tool',
    content: toolResultContent(failed ? failurePayload : outcome.result),
    name: toolCall.function.name,
    toolCallId: toolCall.id,
    toolName: toolCall.function.name,
    ...(failed && { isError: true }),
    ...(outcome.replacedByHook !== undefined && { metadata: { replacedByHook: outcome.replacedByHook } }),
  };
}
