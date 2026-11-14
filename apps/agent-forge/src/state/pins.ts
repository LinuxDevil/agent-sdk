import type { ChatMessage, SpanEvent, ToolPin } from '../../shared/wireTypes';

/**
 * "Run from here" pin helpers (T04): turn a tool span's recorded
 * attributes into a {@link ToolPin}, and find the input a pinned re-run
 * re-sends. Pure functions - the AppState fields (`pins`, `togglePin`,
 * `runFromHere`, `clearPins`) live in AppState.tsx.
 *
 * A tool span only carries its call's arguments/result when content
 * capture was on for that run (`gen_ai.tool.call.arguments` /
 * `gen_ai.tool.call.result`, src/execution/semconv.ts; the deprecated
 * `args`/`result` attributes are the fallback). Without a recorded result
 * there is nothing to pin - `pinFromSpan` returns `undefined` and the UI
 * says why.
 */

/** The attribute names a tool span records its call under (semconv.ts `GenAiAttr`/`LegacyAttr`). */
const TOOL_NAME_KEYS = ['gen_ai.tool.name', 'toolName'] as const;
const ARGS_KEYS = ['gen_ai.tool.call.arguments', 'args'] as const;
const RESULT_KEYS = ['gen_ai.tool.call.result', 'result'] as const;

function attribute(span: SpanEvent, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (span.attributes[key] !== undefined) return span.attributes[key];
  }
  return undefined;
}

/**
 * A captured-content attribute is JSON-encoded by the SDK
 * (`encodeContent`, src/execution/genAiSpans.ts); decode it, keeping the
 * raw value when it is not a string or does not parse (a legacy
 * `result`/`args` attribute may already be plain data).
 */
function decoded(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The pin a tool span offers, or `undefined` when the span is not a tool
 * call or recorded no result. `nodeId` is the canvas node the sheet was
 * opened for (`tool:<key>`) - display and un-pinning only; matching on
 * the server is by `toolName`/`args`.
 */
export function pinFromSpan(nodeId: string, span: SpanEvent): ToolPin | undefined {
  const toolName = attribute(span, TOOL_NAME_KEYS);
  if (typeof toolName !== 'string' || toolName === '') return undefined;
  const result = decoded(attribute(span, RESULT_KEYS));
  if (result === undefined) return undefined;
  const args = asRecord(decoded(attribute(span, ARGS_KEYS)));
  return {
    nodeId,
    toolName,
    ...(args !== undefined && { args }),
    result,
  };
}

/**
 * The newest `user` message's content - what "Run from here" re-sends.
 * `undefined` when the transcript has no user turn yet (the run button
 * then stays disabled with its "Send a message first" reason).
 */
export function lastUserInput(messages: readonly ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'user' && message.content !== '') return message.content;
  }
  return undefined;
}
