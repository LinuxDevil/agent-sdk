import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { connectAuthorStream, newRequestId, type AuthorStreamState } from '../authorStream';
import type { AuthorClientMessage, AuthorServerEvent } from '../../../shared/authorWire';

type Handler = (event: { data?: unknown; code?: number }) => void;

/**
 * The smallest WebSocket stand-in the stream wrapper drives: `readyState`,
 * `send`, `close` and `addEventListener`. The server side is scripted by the
 * test (`serverOpen`/`serverMessage`/`serverDrop`); `instances` records every
 * socket the wrapper opened so a test can count reconnects.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;

  readyState = 0;
  readonly url: string;
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, Handler[]>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, handler: Handler): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit('close', { code: 1000 });
  }

  emit(type: string, event: { data?: unknown; code?: number }): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  /** The handshake completed. */
  serverOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open', {});
  }

  /** A JSON text frame arrived. */
  serverMessage(event: AuthorServerEvent): void {
    this.emit('message', { data: JSON.stringify(event) });
  }

  /** The socket dropped (or was closed server-side) with `code`. */
  serverDrop(code = 1006): void {
    this.readyState = 3;
    this.emit('close', { code });
  }
}

describe('connectAuthorStream', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const open = (id: string) =>
    new FakeWebSocket(`ws://studio.test/assistant/stream?session=${id}`) as unknown as WebSocket;

  function setup(options?: { retryMs?: number; onOpen?: () => void }) {
    const events: AuthorServerEvent[] = [];
    const states: AuthorStreamState[] = [];
    const { onOpen, ...rest } = options ?? {};
    const stream = connectAuthorStream(
      'sess-1',
      {
        onEvent: (event) => events.push(event),
        onState: (state) => states.push(state),
        ...(onOpen ? { onOpen } : {}),
      },
      { open, retryMs: 1000, ...rest }
    );
    return { stream, events, states };
  }

  it('reports connecting then open, and send() writes the JSON message', () => {
    const { stream, states } = setup();
    expect(states).toEqual(['connecting']);
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    expect(states).toEqual(['connecting', 'open']);
    const message: AuthorClientMessage = { type: 'chat.send', requestId: 'r_12345678', text: 'hi' };
    expect(stream.send(message)).toBe(true);
    expect(JSON.parse(ws.sent[0])).toEqual(message);
  });

  it('delivers server events, ignoring malformed and binary frames', () => {
    const { stream, events } = setup();
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    ws.serverMessage({ type: 'turn.started', requestId: 'r1', seq: 1 });
    ws.emit('message', { data: '{broken' });
    ws.emit('message', { data: new ArrayBuffer(4) });
    expect(events).toEqual([{ type: 'turn.started', requestId: 'r1', seq: 1 }]);
    stream.close();
  });

  it('calls onOpen on each (re)connect', () => {
    const opens: number[] = [];
    let count = 0;
    setup({ onOpen: () => opens.push(++count) });
    const first = FakeWebSocket.instances[0];
    first.serverOpen();
    first.serverDrop();
    vi.advanceTimersByTime(1000);
    FakeWebSocket.instances[1].serverOpen();
    expect(opens).toEqual([1, 2]);
  });

  it('reconnects after a drop and reports reconnecting then open', () => {
    const { stream, states } = setup();
    const first = FakeWebSocket.instances[0];
    first.serverOpen();
    first.serverDrop();
    expect(states).toEqual(['connecting', 'open', 'reconnecting']);
    // While down, send() refuses instead of throwing.
    expect(stream.send({ type: 'chat.stop', requestId: 'r_x1234567' })).toBe(false);
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const second = FakeWebSocket.instances[1];
    second.serverOpen();
    expect(states).toEqual(['connecting', 'open', 'reconnecting', 'open']);
    expect(stream.send({ type: 'chat.stop', requestId: 'r_x1234567' })).toBe(true);
    stream.close();
  });

  it('keeps retrying until close(), even across repeated drops', () => {
    setup();
    FakeWebSocket.instances[0].serverDrop();
    vi.advanceTimersByTime(1000);
    FakeWebSocket.instances[1].serverDrop();
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it('a 4404 close goes straight to closed and never retries', () => {
    const { states } = setup();
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    ws.serverDrop(4404);
    vi.advanceTimersByTime(60_000);
    expect(states).toEqual(['connecting', 'open', 'closed']);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('close() while waiting to retry reports closed and stops retries', () => {
    const { stream, states } = setup();
    FakeWebSocket.instances[0].serverDrop();
    expect(states.at(-1)).toBe('reconnecting');
    stream.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(states.at(-1)).toBe('closed');
    expect(stream.send({ type: 'chat.stop', requestId: 'r_x1234567' })).toBe(false);
  });

  it('close() on an open socket closes it and reports closed', () => {
    const { stream, states } = setup();
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    stream.close();
    expect(ws.closed).toBe(true);
    expect(states).toEqual(['connecting', 'open', 'closed']);
    expect(stream.send({ type: 'chat.stop', requestId: 'r_x1234567' })).toBe(false);
  });

  it('send() returns false while the socket is still connecting', () => {
    const { stream } = setup();
    expect(stream.send({ type: 'chat.stop', requestId: 'r_x1234567' })).toBe(false);
    expect(FakeWebSocket.instances[0].sent).toEqual([]);
    stream.close();
  });
});

describe('newRequestId', () => {
  it('makes r_-prefixed ids inside the requestId charset', () => {
    const id = newRequestId();
    expect(id).toMatch(/^r_[0-9a-f]{32}$/);
    expect(newRequestId()).not.toBe(id);
  });
});
