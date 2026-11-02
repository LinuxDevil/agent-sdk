/**
 * The browser side of `WS /assistant/stream`: a small reconnecting
 * wrapper the Author panel's chat hook drives. A dropped socket retries
 * every `retryMs` until `close()` - the server holds the durable chat
 * (the persisted transcript plus, in AA04, the replay buffer), so a
 * reconnect simply re-subscribes; the 4404 "Chat not found" close is
 * terminal and reported `closed` without retrying.
 *
 * `send` refuses (returns `false`, sends nothing) whenever there is no
 * open socket - connecting, reconnecting or closed - so the UI can
 * disable its input on the `onState` callback instead of guessing.
 */
import type { AuthorClientMessage, AuthorServerEvent } from '../../shared/authorWire';
import { runtimeClient } from '../runtime/runtimeClient';

/** Where the wrapper is in its lifecycle; reported via `onState` on every transition. */
export type AuthorStreamState = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** The stream's callbacks: events verbatim, state on transitions, `onOpen` after each successful (re)connect. */
// fallow-ignore-next-line unused-export -- the Author chat hook (AA15a) implements it
export interface AuthorStreamHandlers {
  onEvent(event: AuthorServerEvent): void;
  onState(state: AuthorStreamState): void;
  /** Fires after every `open` - AA04 sends `chat.resume` here. */
  onOpen?(): void;
}

/** The handle `connectAuthorStream` returns: write client messages, or end the stream for good. */
// fallow-ignore-next-line unused-export -- the Author chat hook (AA15a) holds it
export interface AuthorStream {
  /** JSON-sends `message` when the socket is open; `false` (nothing sent) otherwise. */
  send(message: AuthorClientMessage): boolean;
  /** Ends the stream: closes the socket and stops the retry timer. */
  close(): void;
}

/** Default wait between a drop and the reconnect attempt. */
const DEFAULT_RETRY_MS = 2000;

/** The server's "session id unknown" close - terminal, never retried (server/author/authorStream.ts). */
const SESSION_NOT_FOUND_CLOSE = 4404;

/**
 * Opens `/assistant/stream` for `sessionId` and keeps it open: on a drop
 * it reports `reconnecting` and re-opens every `retryMs` until `close()`.
 * `options.open` is the socket seam (tests pass a fake; the default is
 * `runtimeClient.openAuthorSocket`, which adds the `?token=`).
 */
// fallow-ignore-next-line unused-export -- the Author chat hook (AA15a) connects through it
export function connectAuthorStream(
  sessionId: string,
  handlers: AuthorStreamHandlers,
  options?: { open?: (id: string) => WebSocket; retryMs?: number }
): AuthorStream {
  const openSocket = options?.open ?? ((id: string) => runtimeClient.openAuthorSocket(id));
  const retryMs = options?.retryMs ?? DEFAULT_RETRY_MS;
  let socket: WebSocket | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let closedByCaller = false;
  let attempts = 0;
  let state: AuthorStreamState | undefined;

  const setState = (next: AuthorStreamState): void => {
    if (state === next) return;
    state = next;
    handlers.onState(next);
  };

  function onClose(code: number): void {
    socket = undefined;
    if (closedByCaller || code === SESSION_NOT_FOUND_CLOSE) {
      setState('closed');
      return;
    }
    setState('reconnecting');
    retryTimer = setTimeout(connect, retryMs);
  }

  function attach(ws: WebSocket): void {
    socket = ws;
    ws.addEventListener('open', () => {
      setState('open');
      handlers.onOpen?.();
    });
    ws.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return; // the protocol is JSON text
      try {
        handlers.onEvent(JSON.parse(event.data) as AuthorServerEvent);
      } catch {
        // A malformed frame never takes the stream down.
      }
    });
    ws.addEventListener('close', (event) => onClose((event as CloseEvent).code));
  }

  function connect(): void {
    attempts += 1;
    // The first attempt is 'connecting'; retries arrive after 'reconnecting'
    // was already reported by the close that scheduled them.
    if (attempts === 1) setState('connecting');
    attach(openSocket(sessionId));
  }

  connect();

  return {
    send(message: AuthorClientMessage): boolean {
      if (socket === undefined || socket.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(message));
      return true;
    },
    close(): void {
      closedByCaller = true;
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      const current = socket;
      socket = undefined;
      // With no live socket (mid-retry) nothing reports 'closed' for us;
      // with one, its close event does (closedByCaller makes it terminal).
      if (current === undefined) {
        setState('closed');
        return;
      }
      current.close();
    },
  };
}

/** A fresh `chat.send`/`chat.stop` `requestId` (the runner's charset, no dashes). */
// fallow-ignore-next-line unused-export -- the Author chat hook (AA15a) stamps requestIds with it
export function newRequestId(): string {
  return `r_${crypto.randomUUID().replace(/-/g, '')}`;
}
