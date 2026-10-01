/**
 * LOU-D15: reads {@link AgentEvent}s back from an HTTP response body, as
 * written by the docs/streaming.md server: SSE (`data: {...}` lines) or
 * newline-delimited JSON (one event per line).
 */

import { isAgentEvent, type AgentEvent } from '../execution/agentEvents';

/** The event on one line, or `undefined` for blank lines, SSE comments/fields and unknown events. */
function parseLine(line: string): AgentEvent | undefined {
  const text = (line.startsWith('data:') ? line.slice(5) : line).trim();
  if (!text.startsWith('{')) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return isAgentEvent(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Yields the events of a streamed response, in order. Accepts SSE framing
 * (`data: <json>`, blank-line separated; `event:`, `id:` and `:` comment
 * lines are ignored) and plain newline-delimited JSON. Lines that are not
 * a known {@link AgentEvent} are skipped. Breaking out of the loop cancels
 * the body.
 *
 * @example
 * ```ts
 * const response = await fetch('/api/agent', { method: 'POST', body: JSON.stringify({ input: 'Hi' }) });
 * for await (const event of parseEventStream(response)) {
 *   if (event.type === 'text.delta') console.log(event.text);
 * }
 * ```
 */
export async function* parseEventStream(response: { body: ReadableStream<Uint8Array> | null }): AsyncGenerator<AgentEvent> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = done ? '' : (lines.pop() ?? '');
      for (const line of lines) {
        const event = parseLine(line);
        if (event) yield event;
      }
      if (done) return;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
