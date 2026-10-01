/**
 * LOU-D15: parseEventStream() reads SSE and NDJSON framed event streams.
 */
import { describe, it, expect } from 'vitest';
import { AGENT_EVENT_SCHEMA_VERSION, type AgentEvent } from '../execution/agentEvents';
import { parseEventStream } from './parseEventStream';

const base = { runId: 'r1', timestamp: new Date(0).toISOString(), v: AGENT_EVENT_SCHEMA_VERSION };
const sample: AgentEvent[] = [
  { ...base, seq: 0, type: 'run.start', agentName: 'a' },
  { ...base, seq: 1, type: 'text.delta', text: 'héllo\nworld' },
  { ...base, seq: 2, type: 'run.done', finishReason: 'stop', text: 'héllo\nworld' },
];

/** A Response whose body arrives in `chunkSize`-byte pieces, so lines and UTF-8 characters are split across reads. */
function chunked(text: string, chunkSize = 7): Response {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  });
  return new Response(body);
}

async function collect(response: { body: ReadableStream<Uint8Array> | null }): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of parseEventStream(response)) out.push(event);
  return out;
}

describe('parseEventStream (LOU-D15)', () => {
  it('reads SSE framing, ignoring comments, event/id fields and blank lines', async () => {
    const sse = `: keep-alive\n\n${sample.map((e) => `event: message\nid: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`).join('')}`;
    expect(await collect(chunked(sse))).toEqual(sample);
    expect(await collect(chunked(sse.replace(/\n/g, '\r\n'), 3))).toEqual(sample);
  });

  it('reads newline-delimited JSON, including a last line without a newline', async () => {
    const ndjson = sample.map((e) => JSON.stringify(e)).join('\n');
    expect(await collect(chunked(ndjson))).toEqual(sample);
  });

  it('skips lines that are not agent events and handles an empty body', async () => {
    const text = `not json\n{"broken":\n${JSON.stringify({ type: 'unknown.event', v: 1, seq: 0 })}\n${JSON.stringify(sample[0])}\n`;
    expect(await collect(chunked(text))).toEqual([sample[0]]);
    expect(await collect({ body: null })).toEqual([]);
  });

  it('breaking out of the loop cancels the body', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify(sample[0])}\n`));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const event of parseEventStream({ body })) {
      expect(event.type).toBe('run.start');
      break;
    }
    expect(cancelled).toBe(true);
  });
});
