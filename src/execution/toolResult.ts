/**
 * A tool that returns nothing (`undefined`, an async generator that
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

/** The default `maxToolResultChars`, about 12k tokens. */
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 50_000;

/** `maxToolResultChars` is a positive integer or `Infinity` (`LOUSHO_CONFIG_INVALID` otherwise). */
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

/** JSON has no `BigInt`, `Map` or `Set`: a BigInt goes as its decimal string, a Map as an object (or entry list), a Set as an array. */
function jsonSafeValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Set) return [...value];
  if (value instanceof Map) {
    const entries = [...value];
    return entries.every(([key]) => typeof key === 'string') ? Object.fromEntries(entries) : entries;
  }
  return value;
}

/** A replacer that also cuts reference cycles: an object inside itself becomes `'[Circular]'` (a shared, non-cyclic one is kept). */
function cycleSafeReplacer(): (this: unknown, key: string, value: unknown) => unknown {
  const ancestors: unknown[] = [];
  return function (this: unknown, _key: string, value: unknown) {
    const safe = jsonSafeValue(value);
    if (typeof safe !== 'object' || safe === null) return safe;
    // `this` is the object holding `value`: drop the ancestors that are not on its path.
    while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
    if (ancestors.includes(safe)) return '[Circular]';
    ancestors.push(safe);
    return safe;
  };
}

/**
 * `result` as JSON. A value `JSON.stringify` cannot encode (a cycle, a BigInt,
 * a throwing `toJSON`) must not fail the run: it is encoded as far as it can
 * be (see {@link jsonSafeValue}, {@link cycleSafeReplacer}), else replaced by
 * an `{error}` the model reads.
 */
function toolResultJson(result: unknown): string {
  try {
    return JSON.stringify(result, (_key, value: unknown) => jsonSafeValue(value)) ?? 'null';
  } catch {
    try {
      return JSON.stringify(result, cycleSafeReplacer()) ?? 'null';
    } catch (error) {
      return JSON.stringify({ error: `The tool result could not be encoded as JSON: ${(error as Error)?.message ?? String(error)}` });
    }
  }
}

/**
 * The `content` of a `tool` message for `result`: always a JSON string (`'null'` for nothing).
 * JSON longer than `maxChars` (default {@link DEFAULT_MAX_TOOL_RESULT_CHARS})
 * becomes a JSON string of its head and tail with a truncation marker (a string result is cut
 * as text, so the model reads it unescaped). `Infinity` turns the cap off.
 */
export function toolResultContent(result: unknown, maxChars: number = DEFAULT_MAX_TOOL_RESULT_CHARS): string {
  const json = toolResultJson(normalizeToolResult(result));
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
