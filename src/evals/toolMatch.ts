/**
 * Tool-call matching and diffing for trajectory assertions (LOU-D7).
 */
import type { EvalToolCall } from './evalResult';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function show(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

/**
 * Differences between `expected` and `actual` where `expected` is a partial
 * deep match: objects need only contain the expected keys, arrays and
 * primitives must be equal. Returns one line per difference (empty = match).
 */
export function diffArgs(expected: unknown, actual: unknown, path = ''): string[] {
  if (isPlainObject(expected) && isPlainObject(actual)) {
    return Object.entries(expected).flatMap(([key, value]) =>
      diffArgs(value, actual[key], path ? `${path}.${key}` : key)
    );
  }
  if (JSON.stringify(expected) === JSON.stringify(actual)) return [];
  return [`${path || 'args'}: expected ${show(expected)}, got ${show(actual)}`];
}

/** Parses the raw `{ function: { name, arguments } }` tool calls of an execution result. */
export function parseToolCalls(
  raw: ReadonlyArray<{ function: { name: string; arguments: string } }>
): EvalToolCall[] {
  return raw.map((call) => {
    try {
      return { name: call.function.name, args: JSON.parse(call.function.arguments) as unknown };
    } catch {
      return { name: call.function.name, args: call.function.arguments };
    }
  });
}

/** True when `names` appear in `calls` in this order (other calls may interleave). */
export function isSubsequence(calls: readonly EvalToolCall[], names: readonly string[]): boolean {
  let next = 0;
  for (const call of calls) {
    if (call.name === names[next]) next++;
  }
  return next === names.length;
}

/** `[a, b]` or `none`, for failure messages. */
export function describeCalled(calls: readonly EvalToolCall[]): string {
  return calls.length === 0 ? 'none' : `[${calls.map((c) => c.name).join(', ')}]`;
}
