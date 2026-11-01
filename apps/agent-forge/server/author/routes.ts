/**
 * Author session routes - `POST/GET /assistant/sessions`,
 * `GET/DELETE /assistant/sessions/:id` (Contract C).
 *
 * Sessions are Studio-global, so the store arrives as a dep (built in
 * `createApp` over `studioPaths().sessions`) rather than coming off the
 * request's workspace - but the chat still edits agents in one workspace,
 * so `POST` stamps `workspaceId` from `workspaceOf(req).ref.id`. Every
 * `:id` is checked against `AUTHOR_SESSION_ID_RE` before the store sees
 * it: a decoded `..`, a `/` or an overlong id is a 400 that never reaches
 * the filesystem.
 *
 * Turns, the WebSocket stream, saves and secrets are later tickets; this
 * is the persisted-session CRUD they all build on.
 */
import type { Express, Request, Response } from 'express';
import { AUTHOR_SESSION_ID_RE, type AuthorFocus } from '../../shared/authorWire';
import { isValidAgentId } from '../../shared/agentId';
import { asyncRoute, paramId, sendError } from '../http/routeUtils';
import { workspaceOf } from '../workspace/middleware';
import type { AuthorSessionStore } from './sessionStore';
import type { AuthorTurnRunner } from './turnRunner';

/** The exact 400 copy a malformed `focus` gets (Contract C's session rows). */
const INVALID_FOCUS_MESSAGE = 'focus must be { mode: "create" } or { mode: "edit", agentId }.';

/**
 * A validated `POST /assistant/sessions` body: the body (and `focus`) may
 * be absent - the Author defaults to creating a new agent; when `focus`
 * is present it must be `{ mode: 'create' }` or `{ mode: 'edit', agentId }`
 * with `agentId` passing `isValidAgentId`.
 */
function parseFocus(body: unknown): { ok: true; focus?: AuthorFocus } | { ok: false } {
  if (body === undefined || body === null) return { ok: true };
  if (typeof body !== 'object' || Array.isArray(body)) return { ok: false };
  const focus = (body as { focus?: unknown }).focus;
  if (focus === undefined) return { ok: true };
  if (typeof focus !== 'object' || focus === null || Array.isArray(focus)) return { ok: false };
  const candidate = focus as { mode?: unknown; agentId?: unknown };
  if (candidate.mode === 'create') return { ok: true, focus: { mode: 'create' } };
  if (candidate.mode === 'edit' && typeof candidate.agentId === 'string' && isValidAgentId(candidate.agentId)) {
    return { ok: true, focus: { mode: 'edit', agentId: candidate.agentId } };
  }
  return { ok: false };
}

/** The request's `:id` as a session id, or `undefined` once the 400 was sent. */
function sessionIdParam(req: Request, res: Response): string | undefined {
  const id = paramId(req);
  if (!AUTHOR_SESSION_ID_RE.test(id)) {
    sendError(res, 400, 'Invalid chat id.', 'INVALID_ID');
    return undefined;
  }
  return id;
}

/**
 * Registers the four session routes. `deps.sessions` is the app's single
 * `AuthorSessionStore` (sessions are Studio-global); the workspace the
 * session belongs to still comes from `workspaceOf(req)` on create.
 * `deps.runner` (the app's AuthorTurnRunner) makes DELETE refuse while a
 * reply is running in that chat - deleting the file mid-turn would lose
 * the in-flight assistant message.
 */
export function registerAuthorRoutes(
  app: Express,
  deps: { sessions: AuthorSessionStore; runner?: Pick<AuthorTurnRunner, 'running'> }
): void {
  // Create a chat: 201 AuthorSession stamped with the request workspace's id.
  app.post(
    '/assistant/sessions',
    asyncRoute(async (req, res) => {
      const parsed = parseFocus(req.body);
      if (!parsed.ok) {
        sendError(res, 400, INVALID_FOCUS_MESSAGE, 'INVALID_INPUT');
        return;
      }
      const session = await deps.sessions.create(parsed.focus, workspaceOf(req).ref.id);
      res.status(201).json(session);
    })
  );

  // The history list: 200 AuthorSessionSummary[], newest updatedAt first.
  app.get(
    '/assistant/sessions',
    asyncRoute(async (_req, res) => {
      res.json(await deps.sessions.list());
    })
  );

  // One session with its transcript: 200 AuthorSession, 404 when unknown.
  app.get(
    '/assistant/sessions/:id',
    asyncRoute(async (req, res) => {
      const id = sessionIdParam(req, res);
      if (id === undefined) return;
      const session = await deps.sessions.get(id);
      if (session === undefined) {
        sendError(res, 404, 'Chat not found.', 'NOT_FOUND');
        return;
      }
      res.json(session);
    })
  );

  // Delete the session file: 204, 409 while a reply is running in the
  // chat, or 404 when there was nothing to remove.
  app.delete(
    '/assistant/sessions/:id',
    asyncRoute(async (req, res) => {
      const id = sessionIdParam(req, res);
      if (id === undefined) return;
      if (deps.runner?.running(id) !== undefined) {
        sendError(res, 409, 'Stop the reply before deleting this chat.', 'BUSY');
        return;
      }
      if (!(await deps.sessions.remove(id))) {
        sendError(res, 404, 'Chat not found.', 'NOT_FOUND');
        return;
      }
      res.status(204).end();
    })
  );
}
