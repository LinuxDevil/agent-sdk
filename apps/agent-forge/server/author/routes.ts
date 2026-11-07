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
  type AuthorMessage,
  type AuthorSaveResponse,
  type AuthorSessionRecord,
  type AuthorToolFailure,
  type AuthorToolPart,
  type AuthorUserMessage,
  type RequestSecretOutput,
} from '../../shared/authorWire';
import { isValidAgentId } from '../../shared/agentId';
import { asyncRoute, paramId, sendError } from '../http/routeUtils';
import type { SecretsStore } from '../secretsStore';
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

/** The longest secret value the card's POST accepts (the store's own ceiling is higher). */
const SECRET_VALUE_MAX_CHARS = 8192;

/**
 * The `requestSecret` tool part a `POST .../secret` body answers: a
 * `state:'pending'` part named `requestSecret` with this `toolCallId`.
 * `undefined` covers both "no such call" and "already settled" - both
 * are `NOT_PENDING` to the caller.
 */
function pendingSecretPart(transcript: readonly AuthorMessage[], toolCallId: string): AuthorToolPart | undefined {
  for (const message of transcript) {
    if (message.role !== 'assistant') continue;
    for (const part of message.parts) {
      if (
        part.type === 'tool' &&
        part.toolCallId === toolCallId &&
        part.name === 'requestSecret' &&
        part.state === 'pending'
      ) {
        return part;
      }
    }
  }
  return undefined;
}

/**
 * The transcript with `toolCallId`'s pending part settled to `done` with
 * `output`, plus the appended `uiEvent: 'secret'` user message the model
 * reads as "[UI event] The user saved/skipped the secret ..." on the
 * continuation turn. Returns the transcript unchanged when the part is
 * no longer pending (a racing second POST lost - the first answer won).
 */
function settleSecretPart(
  transcript: readonly AuthorMessage[],
  toolCallId: string,
  output: RequestSecretOutput,
  message: AuthorUserMessage
): AuthorMessage[] | undefined {
  if (pendingSecretPart(transcript, toolCallId) === undefined) return undefined;
  const settled = transcript.map((entry) =>
    entry.role !== 'assistant'
      ? entry
      : {
          ...entry,
          parts: entry.parts.map((part) =>
            part.type === 'tool' && part.toolCallId === toolCallId ? { ...part, state: 'done' as const, output } : part
          ),
        }
  );
  return [...settled, message];
}

/**
 * The answer half of a `POST .../secret` body, checked after the card
 * lookup and name match: exactly one of `value` (1..
 * SECRET_VALUE_MAX_CHARS of non-blank text - the store refuses
 * whitespace-only too) or `declined: true`. Anything else is the card's
 * 'Enter a value, or skip.' 400 - the refusal never echoes the value.
 */
function secretAnswer(body: unknown): { ok: true; value: string } | { ok: true; declined: true } | { ok: false } {
  const candidate = (typeof body === 'object' && body !== null ? body : {}) as {
    value?: unknown;
    declined?: unknown;
  };
  const hasValue = typeof candidate.value === 'string';
  if (candidate.declined === true && !hasValue) return { ok: true, declined: true };
  if (hasValue && candidate.declined !== true) {
    const value = candidate.value as string;
    if (value.length <= SECRET_VALUE_MAX_CHARS && value.trim().length > 0) return { ok: true, value };
  }
  return { ok: false };
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
    /**
     * The app's named-secrets store (D13): the `POST .../secret` card
     * answer writes through its encrypted `setSecret` path. The value
     * never enters the transcript, the WS stream or a log line - only
     * the outcome is persisted.
     */
    secrets: SecretsStore;
    runner?: Pick<AuthorTurnRunner, 'running' | 'continueAfterUiEvent'>;
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

  // The SecretCard's submit (AA14): the value goes straight to the
  // encrypted secrets store, the pending requestSecret part settles to
  // 'done' with only the outcome, a `uiEvent: 'secret'` user message is
  // appended for the model, and - after the 204 is on the wire - the
  // continuation turn starts so the Author reacts to the outcome.
  app.post(
    '/assistant/sessions/:id/secret',
    asyncRoute(async (req, res) => {
      const id = sessionIdParam(req, res);
      if (id === undefined) return;
      const session = await deps.sessions.get(id);
      if (session === undefined) {
        sendError(res, 404, 'Chat not found.', 'NOT_FOUND');
        return;
      }
      if (deps.runner?.running(id) !== undefined) {
        sendError(res, 409, 'Wait for the Author to finish replying, then try again.', 'BUSY');
        return;
      }
      const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as {
        toolCallId?: unknown;
        name?: unknown;
        value?: unknown;
        declined?: unknown;
      };
      const toolCallId = typeof body.toolCallId === 'string' ? body.toolCallId : '';
      const part = pendingSecretPart(session.transcript, toolCallId);
      if (part === undefined) {
        sendError(res, 404, 'This request is no longer waiting for a value.', 'NOT_PENDING');
        return;
      }
      const name = (part.input as { name?: unknown } | null)?.name;
      if (body.name !== name) {
        sendError(res, 400, 'The secret name does not match the request.', 'INVALID_INPUT');
        return;
      }
      const answer = secretAnswer(body);
      if (!answer.ok) {
        sendError(res, 400, 'Enter a value, or skip.', 'INVALID_INPUT');
        return;
      }
      // `name` came from the stored card input, which the tool's schema
      // already validated against the UPPER_SNAKE_CASE shape - and the
      // store re-validates before writing anyway.
      const secretName = name as string;
      const outcome: 'saved' | 'declined' = 'declined' in answer ? 'declined' : 'saved';
      const output: RequestSecretOutput =
        outcome === 'declined'
          ? {
              ok: false,
              code: 'DECLINED',
              name: secretName,
              error: `The user chose not to enter ${secretName} now.`,
              userMessage: 'Skipped for now.',
            }
          : { ok: true, name: secretName, status: 'saved' };
      const message: AuthorUserMessage = {
        id: `m_${randomUUID()}`,
        role: 'user',
        text: '',
        at: new Date().toISOString(),
        uiEvent: { kind: 'secret', toolCallId, name: secretName, outcome },
      };
      // A racing second answer loses here: the winner's update already
      // settled the part, so the loser writes nothing and gets
      // NOT_PENDING (the pre-check above passed before the winner's
      // update landed).
      let settled = false;
      await deps.sessions.update(id, (s) => {
        const transcript = settleSecretPart(s.transcript, toolCallId, output, message);
        if (transcript === undefined) return s;
        // The store write sits inside the session lock so a racing
        // answer that lost the pending part cannot overwrite the
        // winner's value.
        if ('value' in answer) deps.secrets.setSecret(secretName, answer.value);
        settled = true;
        return { ...s, transcript };
      });
      if (!settled) {
        sendError(res, 404, 'This request is no longer waiting for a value.', 'NOT_PENDING');
        return;
      }
      res.status(204).end();
      // The 204 is already on the wire so the card can close; the
      // continuation turn streams over the session's WS.
      void deps.runner?.continueAfterUiEvent(id).catch(() => undefined);
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
