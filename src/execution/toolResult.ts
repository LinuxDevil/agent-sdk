/**
 * LOU-341: a tool that returns nothing (`undefined`, an async generator that
 * yields nothing, a value `JSON.stringify` drops such as a function) has the
 * result `null`. Without this, `JSON.stringify(undefined)` is `undefined` and
 * the transcript gets a `tool` message with `content: undefined`, which
 * providers reject and a session store or checkpoint cannot round-trip.
 */

/** A tool's result with "nothing" normalised to `null`. */
export function normalizeToolResult(result: unknown): unknown {
  return result === undefined ? null : result;
}

/** The `content` of a `tool` message for `result`: always a JSON string (`'null'` for nothing). */
export function toolResultContent(result: unknown): string {
  return JSON.stringify(normalizeToolResult(result)) ?? 'null';
}
