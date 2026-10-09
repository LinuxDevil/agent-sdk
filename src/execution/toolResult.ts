/**
 * LOU-341: a tool that returns nothing (`undefined`, an async generator that
 * yields nothing, a value `JSON.stringify` drops such as a function) has the
 * result `null`. Without this, `JSON.stringify(undefined)` is `undefined` and
 * the transcript gets a `tool` message with `content: undefined`, which
 * providers reject and a session store or checkpoint cannot round-trip.
 */
import type { Message, ToolCall } from '../providers';
import type { ToolCallOutcome } from './toolCallExecution';
import { ConfigurationError } from './errors';

/** A tool's result with "nothing" normalised to `null`. */
export function normalizeToolResult(result: unknown): unknown {
  return result === undefined ? null : result;
}

/** Eve TOOLS-F8: the default `maxToolResultChars`, about 12k tokens. */
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 50_000;

/** Eve TOOLS-F8: `maxToolResultChars` is a positive integer or `Infinity` (`LOUSHO_CONFIG_INVALID` otherwise). */
export function assertMaxToolResultChars(value: unknown, caller: string): void {
  if (value === undefined || value === Infinity || (typeof value === 'number' && Number.isInteger(value) && value >= 1)) return;
  throw new ConfigurationError(
    `${caller}: 'maxToolResultChars' must be a positive integer or Infinity, got ${String(value)}. Example: { maxToolResultChars: 20_000 }.`,
    'maxToolResultChars'
  );
}

/**
 * `text` cut to about `max` characters: its head and tail, with a marker in
 * between saying how many characters were left out.
 */
function headAndTail(text: string, max: number): string {
  const head = Math.ceil(max * 0.6);
  const tail = max - head;
  const cut = text.length - head - tail;
  const marker = `\n\n[... ${cut} characters truncated: the tool result had ${text.length} characters, more than maxToolResultChars (${max}) ...]\n\n`;
  return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ''}`;
}

/**
 * The `content` of a `tool` message for `result`: always a JSON string (`'null'` for nothing).
 * Eve TOOLS-F8: JSON longer than `maxChars` (default {@link DEFAULT_MAX_TOOL_RESULT_CHARS})
 * becomes a JSON string of its head and tail with a truncation marker (a string result is cut
 * as text, so the model reads it unescaped). `Infinity` turns the cap off.
 */
export function toolResultContent(result: unknown, maxChars: number = DEFAULT_MAX_TOOL_RESULT_CHARS): string {
  const json = JSON.stringify(normalizeToolResult(result)) ?? 'null';
  if (json.length <= maxChars) return json;
  return JSON.stringify(headAndTail(typeof result === 'string' ? result : json, maxChars));
}

/**
 * The `tool` message a settled call leaves on the transcript. A failed tool
 * carries `{error}` as its content - `result` is null then, so the model
 * would otherwise see a bare "null" and never learn the call failed; a
 * failure that already has a structured result (argument validation) keeps
 * it. A hook-replaced result is recorded under `metadata.replacedByHook`.
 */
export function toolOutcomeMessage(toolCall: ToolCall, outcome: ToolCallOutcome, maxChars?: number): Message {
  const failed = outcome.error !== undefined;
  const failurePayload = outcome.result ?? { error: outcome.error };
  return {
    role: 'tool',
    content: toolResultContent(failed ? failurePayload : outcome.result, maxChars),
    name: toolCall.function.name,
    toolCallId: toolCall.id,
    toolName: toolCall.function.name,
    ...(failed && { isError: true }),
    ...(outcome.replacedByHook !== undefined && { metadata: { replacedByHook: outcome.replacedByHook } }),
  };
}
