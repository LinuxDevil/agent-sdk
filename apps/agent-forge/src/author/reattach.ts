/**
 * The reattach helpers the Author chat hook drives when its stream ends
 * or a chat (re)opens: a verdict on whether a lost socket is worth
 * reattaching (`streamEndRecovery`), a dedupe that drops replayed events
 * the client already rendered (`acceptEvent`), and the pending-request
 * marker in `localStorage` that survives a reload.
 *
 * The pass itself lives in the hook: on `drop`/`busy` (or a session
 * record whose `runningRequestId` is set) it waits for the socket to
 * open, sends `chat.resume { requestId, afterSeq: lastSeq }`, applies
 * events through `acceptEvent`, and on a terminal event - or after
 * `REATTACH_TIMEOUT_MS` of silence - refetches the session record and
 * replaces local messages with the stored transcript (server wins). If
 * the record still shows a running reply it retries up to
 * `REATTACH_MAX_ATTEMPTS`, then shows `REATTACH_GAVE_UP`.
 */
import type { AuthorServerEvent } from '../../shared/authorWire';

/** What the end of a stream means for reattachment. */
export type StreamEnd = 'none' | 'drop' | 'busy';

/**
 * Whether a finished stream needs the reattach pass - the Author port of
 * the "stream ends" state machine, simplified to WS drops: a user stop
 * needs nothing, a `BUSY` `turn.error` means another reply is running
 * (reattach to it, not to ours), and a socket that closed while a reply
 * streamed is a `drop`. Everything else is `none`.
 */
export function streamEndRecovery(input: {
  wasStreaming: boolean;
  socketClosed: boolean;
  errorCode?: string;
  stoppedByUser: boolean;
}): StreamEnd {
  if (input.stoppedByUser) return 'none';
  if (input.errorCode === 'BUSY') return 'busy';
  if (input.wasStreaming && input.socketClosed) return 'drop';
  return 'none';
}

/** The one in-flight `chat.send` a reload can still reattach to. */
export interface PendingRequest {
  sessionId: string;
  requestId: string;
  lastSeq: number;
}

/** The localStorage key the pending request is written under (JSON `PendingRequest`). */
export const PENDING_REQUEST_KEY = 'forge.author.pendingRequest';

/**
 * Writes (or, for `null`, removes) the pending-request marker. Every
 * storage access is wrapped in try/catch: a denied or full localStorage
 * must never break the chat - losing the marker only costs one resume.
 */
export function savePendingRequest(p: PendingRequest | null): void {
  try {
    if (p === null) {
      window.localStorage.removeItem(PENDING_REQUEST_KEY);
      return;
    }
    window.localStorage.setItem(PENDING_REQUEST_KEY, JSON.stringify(p));
  } catch {
    // Storage denied or full: the chat still works, reattach just can't.
  }
}

/**
 * Reads the pending-request marker back (post-reload reattach), `null`
 * when absent, malformed or unreadable. Malformed entries are treated
 * like absent ones - a wrong shape is never trusted.
 */
export function loadPendingRequest(): PendingRequest | null {
  try {
    const raw = window.localStorage.getItem(PENDING_REQUEST_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<PendingRequest> | null;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof parsed.sessionId === 'string' &&
      typeof parsed.requestId === 'string' &&
      typeof parsed.lastSeq === 'number'
    ) {
      return { sessionId: parsed.sessionId, requestId: parsed.requestId, lastSeq: parsed.lastSeq };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The dedupe a resumed stream applies to each incoming event: `seq 0`
 * (per-socket replies like `UNKNOWN_REQUEST`) always applies; an event
 * from another `requestId` than the active turn always applies (a new
 * turn); an event of the active turn applies only past `lastSeq`, so
 * replayed frames the client already rendered are dropped.
 */
export function acceptEvent(
  lastSeq: number,
  activeRequestId: string | null,
  event: AuthorServerEvent
): boolean {
  if (event.seq === 0) return true;
  if (activeRequestId === null || event.requestId !== activeRequestId) return true;
  return event.seq > lastSeq;
}

/** Silence after a `chat.resume` at which the hook gives up waiting and reconciles. */
export const REATTACH_TIMEOUT_MS = 5000;

/** How many times the hook resends `chat.resume` while the record still shows a running reply. */
export const REATTACH_MAX_ATTEMPTS = 3;

/** The ErrorNote shown when every reattach attempt timed out. */
export const REATTACH_GAVE_UP =
  'Could not reconnect to this reply. Your chat is saved; reopen it from History to see the latest.';
