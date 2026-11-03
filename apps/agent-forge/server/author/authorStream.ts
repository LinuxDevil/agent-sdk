/**
 * `WS /assistant/stream?session=<id>` - the Agent Author's chat transport.
 *
 * One socket subscribes to one session's turns: the server forwards every
 * `AuthorServerEvent` the `AuthorTurnRunner` emits for that session (all
 * subscribers of the same session see the same frames), and accepts
 * `chat.send`/`chat.stop` frames back. `chat.resume` (AA04's reattach) and
 * any unreadable or unknown frame get a `BAD_MESSAGE` `turn.error` on the
 * sending socket only - one client's garbage never reaches the others.
 *
 * Registered on the server's one `UpgradeRouter` under
 * {@link AUTHOR_STREAM_PATH}, so the shared Host/Origin/token gate has
 * already run when this handler executes (like wsServer.ts and
 * eventsWs.ts, it owns no `upgrade` listener of its own). The only check
 * left to do here is the `session` query: an id `AUTHOR_SESSION_ID_RE`
 * rejects, or one the store has no file for, closes right after the
 * upgrade with code 4404 'Chat not found' - a close reason needs the
 * handshake first, so the socket is always accepted, then maybe closed.
 */
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import {
  type AuthorClientMessage,
  type AuthorFocus,
  type AuthorServerEvent,
} from '../../shared/authorWire';
import { isValidAgentId } from '../../shared/agentId';
import type { UpgradeHandler } from '../ws/upgradeRouter';
import type { AuthorSessionStore } from './sessionStore';
import type { AuthorTurnRunner } from './turnRunner';

/**
 * The close code an unknown or malformed `session` id gets after the
 * upgrade (HTTP has no say once the handshake started; 4xxx is the
 * WS private-use range the client keys its "don't retry" on).
 */
const SESSION_NOT_FOUND_CLOSE = 4404;
const SESSION_NOT_FOUND_REASON = 'Chat not found';

/** The BAD_MESSAGE `turn.error`'s text: one fixed sentence, never an echo of the frame. */
const BAD_MESSAGE = 'Studio could not read that message.';

/** What `chat.resume` (and every unknown frame) is answered with until AA04 lands it. */
function badMessage(requestId: string): AuthorServerEvent {
  return { type: 'turn.error', requestId, seq: 0, message: BAD_MESSAGE, code: 'BAD_MESSAGE' };
}

function send(ws: WebSocket, event: AuthorServerEvent): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
  }
}

/** A `chat.send`'s optional `focus`, checked field by field like the REST route's parseFocus. */
function parseFocus(value: unknown): { ok: true; focus?: AuthorFocus } | { ok: false } {
  if (value === undefined) return { ok: true };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false };
  const candidate = value as { mode?: unknown; agentId?: unknown };
  if (candidate.mode === 'create') return { ok: true, focus: { mode: 'create' } };
  if (candidate.mode === 'edit' && typeof candidate.agentId === 'string' && isValidAgentId(candidate.agentId)) {
    return { ok: true, focus: { mode: 'edit', agentId: candidate.agentId } };
  }
  return { ok: false };
}

/**
 * One raw text frame as a client message, or `undefined` when it isn't
 * strict JSON of a known shape (wrong `type`, missing `requestId`,
 * non-string `text`, malformed `focus`). `chat.resume` parses fine - it is
 * a known type - and the dispatch answers it BAD_MESSAGE until AA04.
 */
function parseClientMessage(raw: string): AuthorClientMessage | undefined {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const message = data as { type?: unknown; requestId?: unknown; text?: unknown; focus?: unknown };
  if (typeof message.requestId !== 'string') return undefined;
  switch (message.type) {
    case 'chat.stop':
      return { type: 'chat.stop', requestId: message.requestId };
    case 'chat.resume':
      return { type: 'chat.resume', requestId: message.requestId };
    case 'chat.send': {
      if (typeof message.text !== 'string') return undefined;
      const parsed = parseFocus(message.focus);
      if (!parsed.ok) return undefined;
      return parsed.focus === undefined
        ? { type: 'chat.send', requestId: message.requestId, text: message.text }
        : { type: 'chat.send', requestId: message.requestId, text: message.text, focus: parsed.focus };
    }
    default:
      return undefined;
  }
}

/** Best-effort `requestId` out of a frame that failed to parse, so its BAD_MESSAGE still lands in the right chat bubble. */
function requestIdIn(raw: string): string {
  try {
    const data = JSON.parse(raw) as { requestId?: unknown };
    return typeof data?.requestId === 'string' ? data.requestId : '';
  } catch {
    return '';
  }
}

/** The frame's text: ws delivers Buffers for text frames (binary is filtered before this runs). */
function frameText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

/**
 * The `/assistant/stream` upgrade handler to register on the app's one
 * `UpgradeRouter` (server/index.ts): `router.register(AUTHOR_STREAM_PATH,
 * createAuthorUpgradeHandler({ runner, sessions }))`. `runner` must be
 * the app's one `AuthorTurnRunner` - the same instance the REST routes
 * consult for `running()`, so `chat.send` shares the session's turn slot
 * with a route-level DELETE's BUSY check.
 */
export function createAuthorUpgradeHandler(deps: {
  runner: AuthorTurnRunner;
  sessions: AuthorSessionStore;
}): UpgradeHandler {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  // sessionId -> connected sockets: a turn's events fan out to every tab
  // watching that chat and to no one else.
  const subscribers = new Map<string, Set<WebSocket>>();

  function broadcast(sessionId: string, event: AuthorServerEvent): void {
    const sockets = subscribers.get(sessionId);
    if (!sockets) return;
    for (const ws of sockets) send(ws, event);
  }

  deps.runner.on('event', (sessionId: string, event: AuthorServerEvent) => broadcast(sessionId, event));

  /** `chat.send`: run the turn; a refused start is a `turn.error` (seq 0) on the sending socket only. */
  async function onChatSend(
    ws: WebSocket,
    sessionId: string,
    message: Extract<AuthorClientMessage, { type: 'chat.send' }>
  ): Promise<void> {
    const req = message.focus === undefined
      ? { requestId: message.requestId, text: message.text }
      : { requestId: message.requestId, text: message.text, focus: message.focus };
    let result;
    try {
      result = await deps.runner.start(sessionId, req);
    } catch {
      send(ws, {
        type: 'turn.error',
        requestId: message.requestId,
        seq: 0,
        message: 'The Author could not start a reply. Try sending your message again.',
      });
      return;
    }
    if (!result.ok) {
      send(ws, {
        type: 'turn.error',
        requestId: message.requestId,
        seq: 0,
        message: result.message,
        code: result.code,
      });
    }
  }

  /** One incoming text frame of an already-subscribed socket. */
  function onFrame(ws: WebSocket, sessionId: string, raw: string): void {
    const message = parseClientMessage(raw);
    if (message === undefined) {
      send(ws, badMessage(requestIdIn(raw)));
      return;
    }
    switch (message.type) {
      case 'chat.send':
        void onChatSend(ws, sessionId, message);
        return;
      case 'chat.stop':
        deps.runner.stop(sessionId, message.requestId);
        return;
      default:
        send(ws, badMessage(message.requestId));
    }
  }

  /** Subscribes the socket, hooks its frames, then validates `session` (a miss closes 4404 after the upgrade). */
  function onConnect(ws: WebSocket, sessionId: string): void {
    let sockets = subscribers.get(sessionId);
    if (!sockets) {
      sockets = new Set();
      subscribers.set(sessionId, sockets);
    }
    sockets.add(ws);
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return; // the protocol is JSON text; binary frames are dropped
      onFrame(ws, sessionId, frameText(data));
    });
    ws.on('close', () => {
      sockets.delete(ws);
      if (sockets.size === 0) subscribers.delete(sessionId);
    });
    // `get` re-checks AUTHOR_SESSION_ID_RE itself and reads the file fresh,
    // so a bad id or a deleted chat is the same 4404. Subscribing before
    // this resolves is deliberate: the socket then can't miss the first
    // events of a turn it just started, and a nonexistent session never
    // has events to leak.
    void deps.sessions
      .get(sessionId)
      .then((session) => {
        if (session === undefined) ws.close(SESSION_NOT_FOUND_CLOSE, SESSION_NOT_FOUND_REASON);
      })
      .catch(() => ws.close(SESSION_NOT_FOUND_CLOSE, SESSION_NOT_FOUND_REASON));
  }

  return (req, socket, head, url) => {
    const sessionId = url.searchParams.get('session') ?? '';
    wss.handleUpgrade(req, socket, head, (ws) => onConnect(ws, sessionId));
  };
}
