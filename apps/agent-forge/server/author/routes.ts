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
import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import {
  AUTHOR_SESSION_ID_RE,
  type AuthorFocus,
  type AuthorSaveResponse,
  type AuthorSessionRecord,
  type AuthorToolFailure,
  type AuthorUserMessage,
} from '../../shared/authorWire';
import { isValidAgentId } from '../../shared/agentId';
import { asyncRoute, paramId, sendError } from '../http/routeUtils';
import { workspaceOf } from '../workspace/middleware';
import type { WorkspaceResolver } from '../workspace/context';
import type { SecretsStore } from '../secretsStore';
import { identityOfProposal, resolveStoredProposal } from './proposal/gate';
import { agentGoneFailure, unknownProposalFailure } from './proposal/failures';
import { requestTextFor, writeProposal } from './proposal/save';
import { computeRequirements, requirementDeps } from './requirements';
import { setAgentEnabledFor } from './tools/stateTools';
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
 * The `proposalId` a `POST .../save` body carries, or `undefined` once the
 * 400 was sent: a string of 1-200 chars, copied verbatim off the card.
 */
function proposalIdOf(body: unknown, res: Response): string | undefined {
  const proposalId =
    typeof body === 'object' && body !== null ? (body as { proposalId?: unknown }).proposalId : undefined;
  if (typeof proposalId !== 'string' || proposalId.length === 0 || proposalId.length > 200) {
    sendError(res, 400, 'Request body must be { proposalId: string } (1-200 characters).', 'INVALID_INPUT');
    return undefined;
  }
  return proposalId;
}

/**
 * The `agentId` a `POST .../enable` body carries, or `undefined` once the
 * 400 was sent: a valid agent id - the value reaches the filesystem, so
 * the same rule the `/agents/:id` middleware enforces applies here.
 */
function enableAgentIdOf(body: unknown, res: Response): string | undefined {
  const agentId =
    typeof body === 'object' && body !== null ? (body as { agentId?: unknown }).agentId : undefined;
  if (typeof agentId !== 'string' || !isValidAgentId(agentId)) {
    sendError(res, 400, 'Request body must be { agentId: string } (a valid agent id).', 'INVALID_INPUT');
    return undefined;
  }
  return agentId;
}

/**
 * A failed save's HTTP answer: the person-facing `userMessage` and the
 * failure `code` (`latestProposalId` travels as `details` so the client
 * can point at the newer card). A `WRITE_FAILED` is a server fault - 500;
 * every refusal is a 400.
 */
function sendSaveFailure(res: Response, failure: AuthorToolFailure): void {
  const details =
    typeof failure.latestProposalId === 'string' ? { latestProposalId: failure.latestProposalId } : undefined;
  sendError(res, failure.code === 'WRITE_FAILED' ? 500 : 400, failure.userMessage, failure.code, details);
}

/**
 * Registers the four session routes. `deps.sessions` is the app's single
 * `AuthorSessionStore` (sessions are Studio-global); the workspace the
 * session belongs to still comes from `workspaceOf(req)` on create.
 * `deps.runner` (the app's AuthorTurnRunner) makes DELETE refuse while a
 * reply is running in that chat - deleting the file mid-turn would lose
 * the in-flight assistant message - and gives GET `/:id` its
 * `runningRequestId` for the reattach decision.
 */
export function registerAuthorRoutes(
  app: Express,
  deps: {
    sessions: AuthorSessionStore;
    runner?: Pick<AuthorTurnRunner, 'running'>;
    /**
     * The app's workspace resolver (PLAN §19.3): `POST .../save` and
     * `POST .../enable` resolve the stored `session.workspaceId` through
     * it to reach the agent stores - never the request's workspace
     * header.
     */
    workspaceResolver: WorkspaceResolver;
    /**
     * The Studio-global secrets store: `POST .../enable` reports the
     * agent's `missingRequirements` count, which reads stored provider
     * keys and named secrets through it (AA13's `requirementDeps`).
     */
    secrets: SecretsStore;
  }
): void {
  /**
   * Session ids with an Apply save in flight: a second Apply while the
   * first still writes is a 409, same as a running reply (the click is
   * the confirmation, and one confirmation buys one save).
   */
  const savesInFlight = new Set<string>();
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

  // One session with its transcript: 200 AuthorSessionRecord (the stored
  // session plus the running turn's requestId, so a client that reopens
  // the chat knows whether to send chat.resume), 404 when unknown.
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
      const record: AuthorSessionRecord = {
        ...session,
        runningRequestId: deps.runner?.running(id)?.requestId ?? null,
      };
      res.json(record);
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

  // The card's Apply button (PLAN §8.3): writes exactly the stored card's
  // spec through the same `writeProposal` the save tools use - the click
  // is the confirmation, so the model's blocking gate does not apply -
  // then appends a `uiEvent: save` user message the model reads as
  // "[UI event] User applied proposal <id>" next turn.
  app.post(
    '/assistant/sessions/:id/save',
    asyncRoute(async (req, res) => {
      const id = sessionIdParam(req, res);
      if (id === undefined) return;
      const proposalId = proposalIdOf(req.body, res);
      if (proposalId === undefined) return;
      const session = await deps.sessions.get(id);
      if (session === undefined) {
        sendError(res, 404, 'Chat not found.', 'NOT_FOUND');
        return;
      }
      if (deps.runner?.running(id) !== undefined || savesInFlight.has(id)) {
        sendError(res, 409, 'Wait for the Author to finish replying, then apply.', 'BUSY');
        return;
      }
      savesInFlight.add(id);
      try {
        const identity = identityOfProposal(session.transcript, proposalId);
        if (identity === null) {
          const failure = unknownProposalFailure('create', proposalId);
          sendError(res, 400, failure.userMessage, failure.code);
          return;
        }
        const ws = await deps.workspaceResolver.resolve(session.workspaceId);
        if (ws === undefined) {
          const failure = agentGoneFailure(identity.kind === 'update' ? identity.agentId : session.workspaceId);
          sendSaveFailure(res, failure);
          return;
        }
        const resolved = resolveStoredProposal(session.transcript, identity, proposalId);
        if (!resolved.ok) {
          sendSaveFailure(res, resolved);
          return;
        }
        const result = await writeProposal(identity, resolved.output, {
          sessionId: id,
          requestText: requestTextFor(session.transcript, proposalId),
          agents: ws.repo,
          versions: ws.versions,
          sessions: deps.sessions,
          bus: ws.events,
        });
        if (!result.ok) {
          sendSaveFailure(res, result);
          return;
        }
        const message: AuthorUserMessage = {
          id: `m_${randomUUID()}`,
          role: 'user',
          text: '',
          at: new Date().toISOString(),
          uiEvent: { kind: 'save', proposalId, agentId: result.agentId, version: result.version },
        };
        await deps.sessions.update(id, (s) => ({ ...s, transcript: [...s.transcript, message] }));
        const body: AuthorSaveResponse = {
          ok: true,
          agentId: result.agentId,
          version: result.version,
          name: result.name,
          enabled: result.enabled,
          message,
        };
        res.status(200).json(body);
      } finally {
        savesInFlight.delete(id);
      }
    })
  );

  // The SuccessCard's "Enable agent" button (research §1.8, PLAN §18's
  // added route): the same `setAgentEnabledFor` write the
  // `setAgentEnabled` tool performs, gated on `createdAgentIds` instead of
  // the model - a chat can only switch on an agent it created. It appends
  // nothing to the transcript and starts no turn, so no turn-state or
  // busy checks apply; a vanished workspace answers like a missing agent.
  app.post(
    '/assistant/sessions/:id/enable',
    asyncRoute(async (req, res) => {
      const id = sessionIdParam(req, res);
      if (id === undefined) return;
      const agentId = enableAgentIdOf(req.body, res);
      if (agentId === undefined) return;
      const session = await deps.sessions.get(id);
      if (session === undefined) {
        sendError(res, 404, 'Chat not found.', 'NOT_FOUND');
        return;
      }
      if (!session.createdAgentIds.includes(agentId)) {
        sendError(res, 400, 'This chat did not create that agent.', 'WRONG_AGENT');
        return;
      }
      const ws = await deps.workspaceResolver.resolve(session.workspaceId);
      if (ws === undefined) {
        sendError(res, 404, "That agent doesn't exist.", 'AGENT_NOT_FOUND');
        return;
      }
      const result = await setAgentEnabledFor(agentId, true, {
        agents: ws.repo,
        bus: ws.events,
        requirements: (spec) => computeRequirements(spec, requirementDeps(ws.ref.root, deps.secrets)),
      });
      if (!result.ok) {
        sendError(res, result.code === 'AGENT_NOT_FOUND' ? 404 : 500, result.userMessage, result.code);
        return;
      }
      res.status(200).json(result);
    })
  );
}
