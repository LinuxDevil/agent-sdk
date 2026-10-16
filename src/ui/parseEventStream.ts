/**
 * Reads {@link AgentEvent}s back from an HTTP response body, as
 * written by the docs/stream-events.md server: SSE (`data: {...}` lines) or
 * newline-delimited JSON (one event per line).
 */

import { isAgentEvent, type AgentEvent } from '../execution/agentEvents';

/** The event in `text`, or `undefined` for non-JSON text and unknown events. */
function parseJson(text: string): AgentEvent | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    return isAgentEvent(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The events of an SSE event's leftover `data:` lines that never joined into
 * one event: each line tried on its own.
 */
function parseLeftover(data: string[]): AgentEvent[] {
  return data.length < 2 ? [] : data.map(parseJson).filter((event): event is AgentEvent => event !== undefined);
}

/** SSE field lines that carry no data (`event:`, `id:`, `retry:` and `:` comments). */
const SSE_FIELD = /^(?::|event:|id:|retry:|event$|id$|retry$)/;

/**
 * Yields the events of a streamed response, in order. Accepts SSE framing
 * (`data: <json>`, blank-line separated; an event's `data:` lines are joined
 * with `\n`, and `event:`, `id:`, `retry:` and `:` comment lines are ignored)
 * and plain newline-delimited JSON. Lines that are not
 * a known {@link AgentEvent} are skipped. Breaking out of the loop cancels
 * the body.
 *
 * @example
 * ```ts
 * const response = await fetch('/api/agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: 'Hi' }) });
 * for await (const event of parseEventStream(response)) {
 *   if (event.type === 'text.delta') console.log(event.text);
 * }
 * ```
 */
export async function* parseEventStream(response: { body: ReadableStream<Uint8Array> | null }): AsyncGenerator<AgentEvent> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const framer = new EventFramer();
  try {
    for await (const line of linesOf(reader)) yield* framer.line(line);
    yield* framer.end();
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

/** The lines of a byte stream (`\n` or `\r\n` separated), decoded as UTF-8; the last one may lack its newline. */
async function* linesOf(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? '' : (lines.pop() ?? '');
    yield* lines;
    if (done) return;
  }
}

/** Turns lines into events: SSE `data:` lines (an event's joined with `\n`) or NDJSON lines. */
class EventFramer {
  /** The `data:` lines of the SSE event being read. */
  private data: string[] = [];

  *line(line: string): Generator<AgentEvent> {
    if (line.startsWith('data:')) {
      // Per the SSE spec an event's data lines are joined with `\n`, so a JSON payload may span several;
      // it is yielded as soon as it is complete rather than at the blank line.
      this.data.push(line.slice(line.startsWith('data: ') ? 6 : 5));
      const event = parseJson(this.data.join('\n'));
      if (event) {
        this.data = [];
        yield event;
      }
      return;
    }
    if (line !== '' && SSE_FIELD.test(line)) return;
    // A blank line ends the SSE event; any other line is NDJSON (and ends a stray unterminated SSE event too).
    yield* this.end();
    const event = line === '' ? undefined : parseJson(line);
    if (event) yield event;
  }

  /** The leftover `data:` lines that never joined into one event. */
  *end(): Generator<AgentEvent> {
    yield* parseLeftover(this.data);
    this.data = [];
  }
}
