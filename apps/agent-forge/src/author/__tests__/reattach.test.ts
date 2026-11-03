import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { breakStorage, installMemoryStorage } from '../../ui/__tests__/memoryStorage';
import {
  acceptEvent,
  loadPendingRequest,
  PENDING_REQUEST_KEY,
  REATTACH_GAVE_UP,
  REATTACH_MAX_ATTEMPTS,
  REATTACH_TIMEOUT_MS,
  savePendingRequest,
  streamEndRecovery,
} from '../reattach';
import type { AuthorServerEvent } from '../../../shared/authorWire';

/**
 * The reattach helpers AA15a's chat hook drives: the stream-end verdict
 * (`none`/`drop`/`busy`), the seq dedupe a resumed stream applies, and the
 * pending-request marker in localStorage that survives a reload. Every
 * storage access is try/catch - a blocked or throwing localStorage must
 * never break the chat.
 */
describe('streamEndRecovery', () => {
  it.each([
    ['stoppedByUser wins over everything', { wasStreaming: true, socketClosed: true, errorCode: 'BUSY', stoppedByUser: true }, 'none'],
    ['a BUSY turn.error means another reply is running', { wasStreaming: false, socketClosed: true, errorCode: 'BUSY', stoppedByUser: false }, 'busy'],
    ['a drop mid-stream reattaches', { wasStreaming: true, socketClosed: true, stoppedByUser: false }, 'drop'],
    ['anything else needs no recovery', { wasStreaming: true, socketClosed: false, stoppedByUser: false }, 'none'],
    ['a clean socket close without streaming needs no recovery', { wasStreaming: false, socketClosed: true, stoppedByUser: false }, 'none'],
  ] as const)('%s', (_label, input, expected) => {
    expect(streamEndRecovery(input)).toBe(expected);
  });
});

describe('acceptEvent', () => {
  const REQ = 'req-aa04-0001';
  const delta = (seq: number, requestId = REQ): AuthorServerEvent => ({
    type: 'text.delta',
    requestId,
    seq,
    text: 'x',
  });

  it('accepts a new seq and drops an old or equal one for the same requestId', () => {
    expect(acceptEvent(3, REQ, delta(4))).toBe(true);
    expect(acceptEvent(3, REQ, delta(3))).toBe(false);
    expect(acceptEvent(3, REQ, delta(2))).toBe(false);
  });

  it('accepts any seq from a different requestId, and anything when no turn is active', () => {
    expect(acceptEvent(3, REQ, delta(1, 'req-aa04-0002'))).toBe(true);
    expect(acceptEvent(3, null, delta(1))).toBe(true);
  });

  it('always accepts seq 0 (per-socket replies bypass dedupe)', () => {
    const error: AuthorServerEvent = {
      type: 'turn.error',
      requestId: REQ,
      seq: 0,
      message: 'nope',
      code: 'UNKNOWN_REQUEST',
    };
    expect(acceptEvent(3, REQ, error)).toBe(true);
    expect(acceptEvent(3, null, error)).toBe(true);
  });
});

describe('reattach constants', () => {
  it('pins the values the hook retries and gives up with', () => {
    expect(REATTACH_TIMEOUT_MS).toBe(5000);
    expect(REATTACH_MAX_ATTEMPTS).toBe(3);
    expect(REATTACH_GAVE_UP).toContain('Could not reconnect');
    expect(PENDING_REQUEST_KEY).toBe('forge.author.pendingRequest');
  });
});

describe('pending-request storage', () => {
  beforeEach(() => {
    installMemoryStorage();
  });

  afterEach(() => {
    window.localStorage.removeItem(PENDING_REQUEST_KEY);
  });

  it('round-trips a PendingRequest and clears it on null', () => {
    const pending = { sessionId: 'sess-1', requestId: 'req-aa04-0001', lastSeq: 7 };
    expect(loadPendingRequest()).toBeNull();
    savePendingRequest(pending);
    expect(loadPendingRequest()).toEqual(pending);
    savePendingRequest(null);
    expect(loadPendingRequest()).toBeNull();
  });

  it('returns null for malformed stored JSON or a wrong shape', () => {
    window.localStorage.setItem(PENDING_REQUEST_KEY, '{not json');
    expect(loadPendingRequest()).toBeNull();
    window.localStorage.setItem(PENDING_REQUEST_KEY, JSON.stringify({ sessionId: 's' }));
    expect(loadPendingRequest()).toBeNull();
    window.localStorage.setItem(PENDING_REQUEST_KEY, JSON.stringify('a string'));
    expect(loadPendingRequest()).toBeNull();
  });

  it('survives a throwing localStorage (save does not throw, load returns null)', () => {
    breakStorage(); // every getItem/setItem throws, as blocked site data does
    expect(() => savePendingRequest({ sessionId: 's', requestId: 'r', lastSeq: 1 })).not.toThrow();
    expect(loadPendingRequest()).toBeNull();
    expect(() => savePendingRequest(null)).not.toThrow();
  });
});
