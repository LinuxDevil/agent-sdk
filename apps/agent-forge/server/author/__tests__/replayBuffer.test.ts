import { describe, it, expect, beforeEach } from 'vitest';
import {
  ReplayBuffer,
  REPLAY_CAPACITY,
  REPLAY_SETTLED_TTL_MS,
} from '../replayBuffer';
import type { AuthorServerEvent } from '../../../shared/authorWire';

/**
 * ReplayBuffer: the per-session ring of one turn's `AuthorServerEvent`s a
 * dropped client re-fetches with `chat.resume`. A running turn answers
 * `replay` (events after the client's cursor), a settled turn answers only
 * its terminal event (never a replay - it could re-show a card saved
 * later), and anything else is `unknown`. The `now` seam stands in for a
 * fake clock so the settled-TTL test doesn't wait two minutes.
 */
describe('ReplayBuffer', () => {
  const SESSION = 'sess-1';
  const REQ = 'req-aa04-0001';
  let now: number;
  let buffer: ReplayBuffer;

  beforeEach(() => {
    now = 1_000_000;
    buffer = new ReplayBuffer({ now: () => now });
  });

  const started = (seq: number, requestId = REQ): AuthorServerEvent => ({
    type: 'turn.started',
    requestId,
    seq,
  });
  const delta = (seq: number): AuthorServerEvent => ({
    type: 'text.delta',
    requestId: REQ,
    seq,
    text: `d${seq}`,
  });
  const toolCall = (seq: number): AuthorServerEvent => ({
    type: 'tool.call',
    requestId: REQ,
    seq,
    toolCallId: `call_${seq}`,
    name: 'listAgents',
    input: {},
  });
  const toolResult = (seq: number): AuthorServerEvent => ({
    type: 'tool.result',
    requestId: REQ,
    seq,
    toolCallId: `call_${seq}`,
    name: 'listAgents',
    output: { ok: true },
    state: 'done',
  });
  const finished = (seq: number): AuthorServerEvent => ({
    type: 'turn.finished',
    requestId: REQ,
    seq,
    finishReason: 'stop',
  });

  /** Records one running turn: turn.started seq 1, then `deltas` text.delta events (seqs 2..n). */
  function recordRunning(deltas: number, sessionId = SESSION, requestId = REQ): AuthorServerEvent[] {
    const events: AuthorServerEvent[] = [started(1, requestId)];
    for (let seq = 2; seq <= deltas + 1; seq += 1) events.push(delta(seq));
    for (const event of events) buffer.record(sessionId, event);
    return events;
  }

  it('replays only the events after the resume cursor while the turn runs', () => {
    const events = recordRunning(4); // seqs 1..5
    expect(buffer.resume(SESSION, REQ, 2)).toEqual({ kind: 'replay', events: events.slice(2) });
    expect(buffer.resume(SESSION, REQ, 0)).toEqual({ kind: 'replay', events });
    expect(buffer.resume(SESSION, REQ, 99)).toEqual({ kind: 'replay', events: [] });
  });

  it('answers unknown for a requestId it never saw, another session, or a replaced turn', () => {
    recordRunning(2);
    expect(buffer.resume(SESSION, 'req-never-seen', 0)).toEqual({ kind: 'unknown' });
    expect(buffer.resume('other-session', REQ, 0)).toEqual({ kind: 'unknown' });
    // A new turn.started replaces the session's entry entirely.
    buffer.record(SESSION, started(1, 'req-aa04-0002'));
    expect(buffer.resume(SESSION, REQ, 0)).toEqual({ kind: 'unknown' });
    expect(buffer.resume(SESSION, 'req-aa04-0002', 0)).toEqual({
      kind: 'replay',
      events: [started(1, 'req-aa04-0002')],
    });
  });

  it('answers a settled turn with only its terminal event, never a replay', () => {
    recordRunning(3);
    const end = finished(5);
    buffer.record(SESSION, end);
    expect(buffer.resume(SESSION, REQ, 0)).toEqual({ kind: 'settled', final: end });
    expect(buffer.resume(SESSION, REQ, 4)).toEqual({ kind: 'settled', final: end });
  });

  it('treats a runner turn.error as the settled terminal event', () => {
    recordRunning(1);
    const end: AuthorServerEvent = { type: 'turn.error', requestId: REQ, seq: 3, message: 'boom' };
    buffer.record(SESSION, end);
    expect(buffer.resume(SESSION, REQ, 0)).toEqual({ kind: 'settled', final: end });
  });

  it('answers unknown once a settled entry outlives REPLAY_SETTLED_TTL_MS', () => {
    recordRunning(1);
    buffer.record(SESSION, finished(3));
    now += REPLAY_SETTLED_TTL_MS; // exactly at the TTL it still answers
    expect(buffer.resume(SESSION, REQ, 0).kind).toBe('settled');
    now += 1;
    expect(buffer.resume(SESSION, REQ, 0)).toEqual({ kind: 'unknown' });
    // An expired entry is also evicted lazily by the next record on any session.
    recordRunning(0, 'sess-2', 'req-aa04-0003');
    expect(buffer.resume(SESSION, REQ, 0)).toEqual({ kind: 'unknown' });
  });

  it('keeps a running turn past the TTL - only settled entries expire', () => {
    recordRunning(2);
    now += REPLAY_SETTLED_TTL_MS * 10;
    expect(buffer.resume(SESSION, REQ, 0).kind).toBe('replay');
  });

  it('on overflow drops the oldest text.delta events first and keeps every tool.* event', () => {
    // seq 1 = turn.started, seqs 2..2001 deltas, 2002..3501 tool.call,
    // 3502..4501 tool.result, 4502..5101 deltas: 5 101 events, 1 101 over.
    const events: AuthorServerEvent[] = [started(1)];
    for (let seq = 2; seq <= 2001; seq += 1) events.push(delta(seq));
    for (let seq = 2002; seq <= 3501; seq += 1) events.push(toolCall(seq));
    for (let seq = 3502; seq <= 4501; seq += 1) events.push(toolResult(seq));
    for (let seq = 4502; seq <= 5101; seq += 1) events.push(delta(seq));
    for (const event of events) buffer.record(SESSION, event);

    const answer = buffer.resume(SESSION, REQ, 0);
    if (answer.kind !== 'replay') throw new Error(`expected replay, got ${answer.kind}`);
    expect(answer.events.length).toBe(REPLAY_CAPACITY);
    // turn.started survived (it is not a text.delta).
    expect(answer.events[0]).toEqual(started(1));
    // Every tool.* event survived; only text.delta events were evicted.
    const tools = answer.events.filter((e) => e.type === 'tool.call' || e.type === 'tool.result');
    expect(tools.length).toBe(2500);
    const deltas = answer.events.filter((e) => e.type === 'text.delta');
    // 2600 recorded deltas - 1101 evictions = 1499 left, oldest gone first.
    expect(deltas.length).toBe(1499);
    expect(deltas[0].seq).toBe(1103);
    // Emission order is preserved after eviction (still sorted by seq).
    const seqs = answer.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });
});
