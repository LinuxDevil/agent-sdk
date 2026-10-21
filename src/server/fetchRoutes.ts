/**
 * The `/chat` HTTP API of `lousho dev`, of the deployed node server and of the
 * Cloudflare Worker, written once on the Fetch API:
 *
 *   GET  /health                         `ok`, never behind the bearer token
 *   POST /chat                           { sessionId, input } in, the turn streamed as SSE out
 *                                        (`data: <AgentEvent>` frames, then `event: done`); an
 *                                        `Idempotency-Key` header makes a resend replay or resume its turn;
 *                                        the deprecated { message } still returns the ExecutionResult
 *   GET  /chat/:sessionId                the session's transcript and pending approvals
 *   POST /chat/:sessionId/approvals/:id  { approved, note? } or { answer }, the continuation streamed
 *                                        (409 for a sign-in pause the user has not signed in to yet)
 *   GET  /oauth/callback                 Where an OAuth provider redirects after sign-in; never behind
 *                                        the bearer token (its protection is the single-use `state`)
 *
 * `Request` in, `Response` out, and no `node:*` import (this file is bundled
 * into Workers): chatRoutes.ts adapts it to `node:http`, the Worker runtime
 * calls it from `fetch()`.
 */
import type { AgentInput } from '../providers/content';
import type { AgentEvent, AgentEventError } from '../execution/agentEvents';
import { describeApproval, type PendingApproval } from '../execution/ApprovalGate';
import { samePrincipal } from '../execution/runPrincipal';
import { assertSessionId } from '../session/sessionStore';
import { idempotencyKeyOf, type AgentSession } from '../session/AgentSession';
import type { Message } from '../providers/llm';
import { toMessages } from '../providers/content';
import { SDKError, SessionAwaitingApprovalError } from '../execution/errors';
import { SESSION_BUSY_RETRY_AFTER_S } from '../channels/channelCore';
import { errorEvents, replayEvents } from '../cli/devEvents';
import type { AuthFn, Principal } from '../auth/types';
import { routeAuth } from '../auth/routeAuth';
import { apiToken } from '../auth/basic';
import type { OAuthCompleteResult } from '../oauth/signIn';
import { createAgentConfigOf, type SimpleAgent } from '../createAgent';
import { claimSession, decodeParam, hostRefusal, postRefusal, releaseSession, sessionOwner } from './requestGuard';

/** What a caller wants to do with a session: read its transcript, send it a turn, or decide one of its approvals. */
export type SessionAction = 'read' | 'chat' | 'approve';

/** The input of `authorizeSession`. */
export interface SessionAccessRequest {
  /** The caller route auth accepted; `undefined` on a route without auth. */
  principal: Principal | undefined;
  sessionId: string;
  action: SessionAction;
}

/** The input of `authorizeApproval`. */
export interface ApprovalAccessRequest {
  /** The caller route auth accepted; `undefined` on a route without auth. */
  principal: Principal | undefined;
  /** The session the approval belongs to (the one in the URL). */
  sessionId: string;
  /** The pending approval; `approval.principal` is whose call it is. */
  approval: PendingApproval;
}

/** Who may use which session and decide which approval over HTTP, and how much of an error a client sees; what a client disconnect does to a turn. */
export interface ChatRoutesAccess {
  /**
   * Whether `principal` may `action` session `sessionId` (read it, send it a
   * turn, decide one of its approvals). Return `false` for a `403`
   * (`LOUSHO_SESSION_FORBIDDEN`). Default: once route auth accepted a caller,
   * a session belongs to the principal whose turn started it, and every other
   * principal gets the `403`; reading an id claims nothing, so a caller cannot
   * squat an id before its user starts it. A decision is left to
   * `authorizeApproval`, which by default lets only the caller the paused run
   * acts for decide. That record is kept in memory per agent object, for the
   * 100 000 most recently used sessions; a session that has a stored
   * transcript (or an unfinished turn) but no owner on record (after a
   * restart, on another replica, past that cap) is refused to every
   * principal, so for anything that outlives one process check ownership here
   * (docs/auth.md). A route without auth, or guarded by one bearer token (one
   * caller), checks nothing. `() => true` lets every caller use every session.
   */
  authorizeSession?: (request: SessionAccessRequest) => boolean | Promise<boolean>;
  /**
   * Whether `principal` may decide (approve, reject or answer) `approval`.
   * Return `false` for a `403` (`LOUSHO_APPROVAL_FORBIDDEN`). Default
   * ({@link callerOwnsApproval}): only the caller the paused run acts for, so a
   * user can confirm their own call but not decide another user's. When an
   * approval must come from someone else (a supervisor), say so here, e.g.
   * `({ principal }) => principal?.claims?.role === 'supervisor'`.
   */
  authorizeApproval?: (request: ApprovalAccessRequest) => boolean | Promise<boolean>;
  /**
   * Stream error messages as they are (provider bodies included). Default
   * `false`: an `error` event, a failed request's `500` and a provider
   * retry/fallback event carry the error's `name` and `code` with a generic
   * message, and the full error is logged on the server. `lousho dev` sets it.
   */
  exposeErrors?: boolean;
  /**
   * What happens to a session turn when its client goes away mid-stream
   * (a closed tab, a dropped connection). `'continue'` (default): the turn
   * runs to its end on the server and is saved to the session, so a tool
   * call that already ran (a refund, an email) is in the transcript and the
   * next turn knows about it; nothing more is written to the closed stream.
   * `'abort'`: the turn is aborted, as a `signal` aborts it (tool results it
   * already has are kept).
   */
  onDisconnect?: 'continue' | 'abort';
  /**
   * Keeps the host alive for a turn that outlives its client: called
   * with a promise that settles once the turn has finished and been saved.
   * Pass the platform's `waitUntil` on serverless hosts (`ctx.waitUntil` on
   * Cloudflare, `waitUntil` from `@vercel/functions`); a long-running Node
   * server needs none.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
  /**
   * Origins (`'https://app.example'`) besides the server's own that a browser
   * may POST from (a front end on another domain; it also needs CORS headers
   * from your host). A POST whose `Origin` is neither gets `403`
   * (`LOUSHO_REQUEST_FORBIDDEN`), as does one marked `Sec-Fetch-Site:
   * cross-site`, so a page on another site cannot start a turn or decide an
   * approval with the user's cookies. Requests without `Origin` (curl, a
   * server) are not affected. `['*']` turns the check off.
   */
  allowedOrigins?: readonly string[];
  /**
   * Require `Content-Type: application/json` on POST routes (default `true`);
   * another type gets `415` (`LOUSHO_UNSUPPORTED_MEDIA_TYPE`). A form or
   * `text/plain` body is what another site can send without a CORS preflight.
   */
  requireJsonBody?: boolean;
  /**
   * Host names (or `host:port`) the `Host` header may carry; other requests
   * get `403` (`LOUSHO_REQUEST_FORBIDDEN`). Guards a server on a private
   * address against DNS rebinding. Default: no check (`lousho dev` checks for
   * loopback names). `/health` and the OAuth callback are not checked.
   */
  allowedHosts?: readonly string[];
  /**
   * How long (ms) a streamed turn may go without writing an event before the
   * server writes an SSE comment (`: ping`) to keep the connection open
   * through proxies and client idle timeouts (nginx's default is 60s, Node's
   * `fetch` gives up after 300s). Default `15000`; `0` turns the heartbeat off.
   */
  heartbeatMs?: number;
}

/**
 * The default `authorizeApproval`: the approval is decided by the caller
 * the paused run acts for (same `id`, `type`, `authenticator` and `issuer`).
 * A run without a principal, or a route without auth, accepts any caller.
 */
export function callerOwnsApproval({ principal, approval }: ApprovalAccessRequest): boolean {
  return approval.principal === undefined || principal === undefined || samePrincipal(principal, approval.principal);
}

/** What the routes need from their host: the live agent and how sessions are opened on it. */
export interface ChatRoutesContext extends ChatRoutesAccess {
  /** Prefix of log lines, e.g. `lousho dev`. */
  name: string;
  /** The live agent; read per request, so a host can swap it (`lousho dev` reloads). */
  agent: () => SimpleAgent;
  /** Opens session `id` on `agent`. Defaults to `agent.session({ id })`. */
  session?: (agent: SimpleAgent, id: string) => AgentSession;
  /** Checkpoints the deprecated `{ message, sessionId }` run under its `sessionId` (needs a checkpoint store on the agent). */
  durableMessage?: boolean;
  /**
   * Called after `GET /oauth/callback` stored a token (or the user
   * declined), e.g. to continue a channel turn that paused on that sign-in.
   * Not awaited by the response.
   */
  afterSignIn?: (result: OAuthCompleteResult) => void;
}

/** Body-size cap for POST routes, matching common Node.js body-size-limit conventions. */
const MAX_BODY_BYTES = 1024 * 1024; // 1MB

/** @internal Thrown by {@link readBody} past the 1MB cap; the route layer maps it to 413. */
export class PayloadTooLargeError extends Error {}

/** @internal `request`'s body as text, capped at the 1MB cap (the body is drained, then 413 is thrown). */
export async function readBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let body = '';
  let bytes = 0;
  // Past the cap the body stops growing but is still drained, so the client
  // can finish writing and the connection does not deadlock; 413 follows.
  for (let chunk = await reader?.read(); chunk && !chunk.done; chunk = await reader?.read()) {
    bytes += chunk.value.byteLength;
    if (bytes <= MAX_BODY_BYTES) body += decoder.decode(chunk.value, { stream: true });
  }
  if (bytes > MAX_BODY_BYTES) throw new PayloadTooLargeError(`Request body exceeds ${MAX_BODY_BYTES} byte limit`);
  return body + decoder.decode();
}

function textResponse(status: number, text: string): Response {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain' } });
}

function jsonResponse(status: number, value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

const DONE_FRAME = 'event: done\ndata: {}\n\n';

/** An SSE comment: clients ignore it, proxies and idle timers see bytes. */
const PING_FRAME = new TextEncoder().encode(': ping\n\n');

const DEFAULT_HEARTBEAT_MS = 15_000;

/** The SSE heartbeat interval: `heartbeatMs`, default 15s; `0` turns it off. */
function heartbeatIntervalOf(access: ChatRoutesAccess): number {
  const ms = access.heartbeatMs;
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_HEARTBEAT_MS;
}

/** What a client sees of an error unless `exposeErrors` is set. */
const PUBLIC_ERROR_MESSAGE = 'The request failed. The server log has the details.';

/**
 * Codes whose message is the SDK's own setup advice (no provider text, no
 * secrets), so a client sees it: a missing provider package names the
 * `npm install` command the server needs.
 */
const SETUP_ERROR_CODES = new Set(['LOUSHO_PEER_MISSING']);

function publicMessage(code: unknown, message: string): string {
  return typeof code === 'string' && SETUP_ERROR_CODES.has(code) ? message : PUBLIC_ERROR_MESSAGE;
}

function publicError({ name, message, code }: AgentEventError): AgentEventError {
  return { name, message: publicMessage(code, message), ...(code !== undefined && { code }) };
}

/**
 * `event` as a client may see it: provider error text (response bodies,
 * chat templates) stays in the server log unless the host exposes errors.
 */
function publicEvent(ctx: ChatRoutesContext, event: AgentEvent): AgentEvent {
  if (ctx.exposeErrors) return event;
  if (event.type === 'error') {
    console.error(`[${ctx.name}] run failed:`, event.error);
    return { ...event, error: publicError(event.error) };
  }
  if (event.type === 'provider.retry' || event.type === 'provider.fallback') return { ...event, error: { ...event.error, message: PUBLIC_ERROR_MESSAGE } };
  return event;
}

/** `run` with {@link publicEvent} applied; a failure it throws ends it with the `error` and `run.done` events of a generic error. */
export async function* publicEvents(ctx: ChatRoutesContext, run: AsyncIterable<AgentEvent>): AsyncGenerator<AgentEvent> {
  if (ctx.exposeErrors) return yield* run;
  try {
    for await (const event of run) yield publicEvent(ctx, event);
  } catch (error) {
    for (const event of errorEvents(error)) yield publicEvent(ctx, event);
  }
}
const warnedLegacy = new Set<string>();

/** Whether a client disconnect aborts the turn it was streaming (`onDisconnect: 'abort'`). */
export function disconnectAborts(access: ChatRoutesAccess): boolean {
  return access.onDisconnect === 'abort';
}

/**
 * `run` for a client that may go away. When the consumer stops early (the
 * response body is cancelled), `run` is not returned, which would abort the
 * turn: it is read to its end in the background, so the turn finishes and is
 * saved, and that read is handed to `waitUntil`. With `onDisconnect: 'abort'`
 * it is `run` itself.
 */
export function outliveClient(ctx: ChatRoutesAccess & { name: string }, run: AsyncIterable<AgentEvent>): AsyncIterable<AgentEvent> {
  if (disconnectAborts(ctx)) return run;
  return {
    [Symbol.asyncIterator]() {
      const iterator = run[Symbol.asyncIterator]();
      let detached: Promise<void> | undefined;
      const finish = async () => {
        try {
          for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
            if (next.value.type === 'error') console.error(`[${ctx.name}] run failed after its client disconnected:`, next.value.error);
          }
        } catch (error) {
          console.error(`[${ctx.name}] run failed after its client disconnected:`, error);
        }
      };
      return {
        next: () => iterator.next(),
        return: () => {
          if (!detached) {
            detached = finish();
            ctx.waitUntil?.(detached);
          }
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}

/**
 * Streams `events` as SSE (`data: <AgentEvent JSON>`, then `event: done`); a
 * failure becomes `error` + `run.done` events. Writing stops when the client
 * goes away (the request's signal, or the response body cancelled); the
 * turn runs on and is saved ({@link outliveClient}), or with `onDisconnect:
 * 'abort'` it is aborted.
 */
function sseResponse(
  request: Request,
  ctx: ChatRoutesContext,
  events: (signal: AbortSignal) => AsyncIterable<AgentEvent>,
  aborter?: AbortController
): Response {
  const aborts = disconnectAborts(ctx);
  const controller = aborter ?? new AbortController();
  if (!aborter && aborts) request.signal.addEventListener('abort', () => controller.abort());
  const encoder = new TextEncoder();
  const frame = (event: AgentEvent) => encoder.encode(`data: ${JSON.stringify(publicEvent(ctx, event))}\n\n`);
  const iterator = outliveClient(ctx, events(controller.signal))[Symbol.asyncIterator]();
  const heartbeatMs = heartbeatIntervalOf(ctx);
  let gone = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stopHeartbeat = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  // An SSE comment frame while no event has been written for `heartbeatMs`: a proxy
  // (nginx drops an idle upstream after 60s) or a client's own idle timeout
  // would otherwise cut a turn whose model or tool is slow to answer.
  const armHeartbeat = () => {
    stopHeartbeat();
    if (heartbeatMs > 0 && !closed && !gone) timer = setTimeout(() => write(PING_FRAME), heartbeatMs);
  };
  const write = (chunk: Uint8Array) => {
    if (closed || gone || !stream) return;
    stream.enqueue(chunk);
    armHeartbeat();
  };
  const close = () => {
    stopHeartbeat();
    if (closed) return;
    closed = true;
    stream?.close();
  };
  const leave = async () => {
    stopHeartbeat();
    if (gone) return;
    gone = true;
    if (aborts) controller.abort();
    await iterator.return?.();
  };
  if (!aborts) request.signal.addEventListener('abort', () => void leave());
  else request.signal.addEventListener('abort', stopHeartbeat);
  const body = new ReadableStream<Uint8Array>({
    start(out) {
      stream = out;
      armHeartbeat();
    },
    async pull() {
      if (gone) return close();
      try {
        const next = await iterator.next();
        if (gone) return stopHeartbeat();
        if (!next.done) return write(frame(next.value));
      } catch (error) {
        if (gone) return stopHeartbeat();
        errorEvents(error).forEach((event) => write(frame(event)));
      }
      write(encoder.encode(DONE_FRAME));
      close();
    },
    cancel: leave,
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  return ((JSON.parse((await readBody(request)) || '{}') as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
}

/** The error status for a failed handler: 413 over the size cap, 400 for bad JSON, else 500 (its message logged, not sent). */
function failureResponse(ctx: ChatRoutesContext, error: unknown): Response {
  const status = error instanceof PayloadTooLargeError ? 413 : error instanceof SyntaxError ? 400 : 500;
  if (status === 400) return jsonResponse(400, { error: (error as Error).message, code: 'LOUSHO_REQUEST_INVALID' });
  if (status !== 500 || ctx.exposeErrors) return jsonResponse(status, { error: (error as Error).message });
  console.error(`[${ctx.name}] request failed:`, error);
  const code = (error as { code?: unknown } | null)?.code;
  return jsonResponse(500, { error: publicMessage(code, String((error as Error | null)?.message)), ...(typeof code === 'string' && code && { code }) });
}

const ACTION_WORDS: Record<SessionAction, string> = { read: 'read', chat: 'continue', approve: 'decide approvals of' };

/**
 * The `403` for a caller `authorizeSession` refuses; `undefined` when it
 * may go on. Without `authorizeSession` (and once route auth accepted a
 * caller), a turn claims an unclaimed session for its caller, and only that
 * caller may read or continue it after; a read claims nothing, so reading an
 * id cannot lock its user out. A session that is stored but has no owner on
 * record (forgotten) is refused to everyone. A decision is left to
 * `authorizeApproval`. `session` is the session the route opened (omitted
 * for the deprecated `{ message, sessionId }` run).
 */
export async function sessionForbidden(
  ctx: ChatRoutesContext,
  principal: Principal | undefined,
  sessionId: string,
  action: SessionAction,
  session?: AgentSession
): Promise<Response | undefined> {
  const allowed = ctx.authorizeSession
    ? await ctx.authorizeSession({ principal, sessionId, action })
    : action === 'approve' || principal === undefined || (await ownsSession(ctx, principal, sessionId, action === 'chat', session));
  if (allowed) return undefined;
  return jsonResponse(403, { error: `Not allowed to ${ACTION_WORDS[action]} this session`, code: 'LOUSHO_SESSION_FORBIDDEN' });
}

/**
 * The default session check: the owner on record decides; without one, a
 * session that is already stored is nobody's to take (its owner may only have
 * been forgotten), and a new one is claimed by a turn (`claim`) - atomically,
 * so of two concurrent first touches only the caller whose claim holds may go on.
 */
async function ownsSession(ctx: ChatRoutesContext, principal: Principal, sessionId: string, claim: boolean, session: AgentSession | undefined): Promise<boolean> {
  const agent = ctx.agent();
  const owner = sessionOwner(agent, sessionId);
  if (owner !== undefined) return samePrincipal(owner, principal);
  if (await sessionStored(ctx, sessionId, session)) return false;
  // The claim itself decides the race - it is atomic with the record,
  // so a concurrent first touch that registered another owner first is refused
  // here instead of streaming a turn inside that principal's session.
  return !claim || claimSession(agent, sessionId, principal);
}

/**
 * Whether session `sessionId` has anything stored: a transcript or an
 * unfinished turn, or, for the deprecated durable `{ message, sessionId }`
 * run, a checkpoint. A store that cannot say counts as stored.
 */
async function sessionStored(ctx: ChatRoutesContext, sessionId: string, session: AgentSession | undefined): Promise<boolean> {
  try {
    if (session) return (await session.load()).length > 0 || (await session.pending()) !== null;
    if (!ctx.durableMessage) return false;
    const checkpoints = createAgentConfigOf(ctx.agent())?.store?.checkpoints;
    return checkpoints !== undefined && (await checkpoints.load(sessionId)) !== null;
  } catch {
    return true;
  }
}

/**
 * `run`, a turn of `session` the default session check let `principal` start:
 * once it ends, a claim whose turn stored nothing (it failed before saving) is
 * dropped, so only a stored session keeps an owner. With `authorizeSession`,
 * or without a principal, `run` itself.
 */
export function claimOnCommit(ctx: ChatRoutesContext, principal: Principal | undefined, session: AgentSession, run: AsyncIterable<AgentEvent>): AsyncIterable<AgentEvent> {
  if (ctx.authorizeSession || principal === undefined) return run;
  return (async function* () {
    try {
      yield* run;
    } finally {
      const agent = ctx.agent();
      if (await sessionStored(ctx, session.id, session)) {
        // The claim taken before the turn can have been forgotten past
        // the owner cap and taken by another principal while it ran; this
        // turn's transcript is then readable as theirs, so a lost re-claim
        // clears it again and the stream ends on a coded error, never a clean `done`.
        if (!claimSession(agent, session.id, principal)) {
          await session.clear().catch(() => undefined);
          throw new SDKError(`Session '${session.id}' was claimed by another principal while this turn ran; the transcript it stored was cleared.`, 'LOUSHO_SESSION_FORBIDDEN');
        }
      } else {
        releaseSession(agent, session.id, principal);
      }
    }
  })();
}

/** Session `sessionId` of the live agent, or the 400 response for an invalid id. */
function openSession(ctx: ChatRoutesContext, sessionId: string): AgentSession | Response {
  try {
    assertSessionId(sessionId);
  } catch (error) {
    return jsonResponse(400, { error: (error as Error).message, code: 'LOUSHO_SESSION_ID_INVALID' });
  }
  const agent = ctx.agent();
  return ctx.session ? ctx.session(agent, sessionId) : agent.session({ id: sessionId });
}

/** A `400` for a request body the route cannot use. */
function badRequest(error: string): Response {
  return jsonResponse(400, { error, code: 'LOUSHO_REQUEST_INVALID' });
}

/**
 * The `409` for a turn sent to a session that is paused on an approval,
 * naming the approvals to decide first; `undefined` when it is not paused.
 * A session that cannot say is left to the turn, which fails on its own.
 */
async function awaitingApproval(session: AgentSession): Promise<Response | undefined> {
  const pending = await session.pending().catch(() => null);
  if (pending?.status !== 'awaiting-approval') return undefined;
  const approvalIds = pending.approvalIds ?? (pending.approvalId ? [pending.approvalId] : []);
  return jsonResponse(409, {
    error: `Session '${session.id}' is paused on an approval: decide it (POST /chat/${session.id}/approvals/:id) before sending a new turn`,
    code: 'LOUSHO_SESSION_AWAITING_APPROVAL',
    ...(pending.approvalId && { approvalId: pending.approvalId }),
    approvalIds,
    ...(pending.approvalKind && { approvalKind: pending.approvalKind }),
  });
}

/** The `409` for a session another process or replica (or an earlier request) is running a turn of. */
function sessionBusy(error: string): Response {
  return jsonResponse(409, { error, code: 'LOUSHO_SESSION_BUSY' }, { 'Retry-After': String(SESSION_BUSY_RETRY_AFTER_S) });
}

/** Whether a turn's first event, or the error that ended it, is a refusal because another process holds the session's lease. */
function isBusyRefusal(first: IteratorResult<AgentEvent> | { failure: unknown }): boolean {
  const error = 'failure' in first ? first.failure : first.done || first.value.type !== 'error' ? undefined : first.value.error;
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'LOUSHO_SESSION_BUSY';
}

/**
 * {@link sseResponse} for a turn, except that a turn refused because another process
 * or replica holds the session's lease (`LOUSHO_SESSION_BUSY`, which fails the turn
 * before it runs anything) is answered with a `409` and `Retry-After` instead of a
 * `200` stream whose only events are the error. The turn's first event decides, so
 * the response starts once the turn has; a failure later in the turn is still in-band.
 */
async function turnResponse(request: Request, ctx: ChatRoutesContext, events: (signal: AbortSignal) => AsyncIterable<AgentEvent>): Promise<Response> {
  const controller = new AbortController();
  if (disconnectAborts(ctx)) request.signal.addEventListener('abort', () => controller.abort());
  const iterator = events(controller.signal)[Symbol.asyncIterator]();
  let head: IteratorResult<AgentEvent> | { failure: unknown };
  try {
    head = await iterator.next();
  } catch (failure) {
    head = { failure };
  }
  if (isBusyRefusal(head)) {
    await iterator.return?.();
    return sessionBusy('This session is running a turn elsewhere; retry shortly.');
  }
  let unread: typeof head | undefined = head;
  const replay: AsyncIterable<AgentEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        const first = unread;
        unread = undefined;
        if (!first) return iterator.next();
        if ('failure' in first) throw first.failure;
        return first;
      },
      return: async () => (await iterator.return?.()) ?? { done: true, value: undefined },
    }),
  };
  return sseResponse(request, ctx, () => replay, controller);
}

/** What an `Idempotency-Key` header may hold: 1-255 visible ASCII characters (a UUID, a ULID, a hash). */
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;

/**
 * The idempotency keys whose turn a request of this process is running now
 * (`<sessionId> <key>`), per agent: a resend of one while it runs is a `409`
 * (`LOUSHO_SESSION_BUSY`) instead of a second turn.
 */
const keysInFlight = new WeakMap<SimpleAgent, Set<string>>();

function keysOf(agent: SimpleAgent): Set<string> {
  let keys = keysInFlight.get(agent);
  if (!keys) keysInFlight.set(agent, (keys = new Set()));
  return keys;
}

/** `input` as the turn's user messages, each marked with `key` (`metadata.idempotencyKey`), which the transcript keeps. */
function keyedInput(input: AgentInput, key: string): Message[] {
  return toMessages(input).map((message) => (message.role === 'user' ? { ...message, metadata: { ...message.metadata, idempotencyKey: key } } : message));
}

/** The messages of the turn whose user message carries `key` (up to the next turn's user message), or `undefined`. */
function keyedTurn(transcript: readonly Message[], key: string): Message[] | undefined {
  const start = transcript.findIndex((message) => idempotencyKeyOf(message) === key);
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < transcript.length && (transcript[end].role !== 'user' || idempotencyKeyOf(transcript[end]) === key)) end += 1;
  return transcript.slice(start, end);
}

function textOf(message: Message | undefined): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  return (content ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/**
 * A turn of `session` sent with an `Idempotency-Key`. The key is stored on the
 * turn's user message (`metadata.idempotencyKey`), in the transcript and in the
 * turn's checkpoint, so it outlives the process:
 *
 * - its turn is running in this process: `409` (`LOUSHO_SESSION_BUSY`);
 * - the session is paused on an approval: `409` (`LOUSHO_SESSION_AWAITING_APPROVAL`), as without a key;
 * - its turn was interrupted (a crash): that turn is resumed, not sent again, and streamed;
 * - its turn is in the transcript: its reply is replayed as `run.done`
 *   (`Idempotent-Replayed: true`), and nothing runs;
 * - else it runs as a new turn, its user message marked with the key.
 */
async function idempotentTurn(request: Request, ctx: ChatRoutesContext, principal: Principal | undefined, session: AgentSession, input: AgentInput, key: string): Promise<Response> {
  const keys = keysOf(ctx.agent());
  const claim = `${session.id} ${key}`;
  if (keys.has(claim)) {
    return sessionBusy(`A request with this Idempotency-Key is still running its turn of session '${session.id}'`);
  }
  keys.add(claim);
  const release = () => void keys.delete(claim);
  try {
    const pending = await session.pending().catch(() => null);
    if (pending?.status === 'awaiting-approval') {
      release();
      return (await awaitingApproval(session))!;
    }
    if (pending?.status === 'in-progress' && pending.idempotencyKey === key) {
      return turnResponse(request, ctx, (signal) => releasing(claimOnCommit(ctx, principal, session, resumedTurn(session, signal)), release));
    }
    const turn = keyedTurn(await session.load(), key);
    if (turn) {
      release();
      const last = [...turn].reverse().find((message) => message.role === 'assistant');
      const replay = replayEvents(textOf(last), last?.metadata?.interrupted === true ? 'aborted' : 'stop');
      const response = sseResponse(request, ctx, async function* () {
        yield* replay;
      });
      response.headers.set('Idempotent-Replayed', 'true');
      return response;
    }
    return turnResponse(request, ctx, (signal) => releasing(claimOnCommit(ctx, principal, session, session.stream(keyedInput(input, key), { signal, principal })), release));
  } catch (error) {
    release();
    throw error;
  }
}

/**
 * The events of `session.resume()`, the turn an earlier request started and a
 * crash interrupted, as they happen (through `session.on()`); a resume that
 * reports none ends with its result's `run.done`.
 */
async function* resumedTurn(session: AgentSession, signal: AbortSignal): AsyncGenerator<AgentEvent> {
  const queue: AgentEvent[] = [];
  let wake: (() => void) | undefined;
  let settled = false;
  let failure: { error: unknown } | undefined;
  let result = null as Awaited<ReturnType<AgentSession['resume']>>;
  const stop = session.on((event) => {
    queue.push(event);
    wake?.();
  });
  void session
    .resume({ signal })
    .then(
      (resumed) => void (result = resumed),
      (error: unknown) => void (failure = { error })
    )
    .finally(() => {
      settled = true;
      wake?.();
    });
  try {
    let done = false;
    for (;;) {
      for (let event = queue.shift(); event; event = queue.shift()) {
        done ||= event.type === 'run.done';
        yield event;
      }
      if (settled) break;
      await new Promise<void>((resolve) => (wake = resolve));
      wake = undefined;
    }
    if (failure) throw failure.error;
    if (!done && result) yield* replayEvents(result.text, result.finishReason);
  } finally {
    stop();
  }
}

/** `run`, calling `release` once when it ends, fails or is returned (also before it started). */
function releasing(run: AsyncIterable<AgentEvent>, release: () => void): AsyncIterable<AgentEvent> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = run[Symbol.asyncIterator]();
      let released = false;
      const done = () => {
        if (released) return;
        released = true;
        release();
      };
      return {
        next: async () => {
          try {
            const next = await iterator.next();
            if (next.done) done();
            return next;
          } catch (error) {
            done();
            throw error;
          }
        },
        return: async () => {
          try {
            return (await iterator.return?.()) ?? { done: true, value: undefined };
          } finally {
            done();
          }
        },
      };
    },
  };
}

type RouteHandler = (request: Request, ctx: ChatRoutesContext, params: string[], principal: Principal | undefined) => Promise<Response>;

/** A `{ sessionId, input }` turn whose input passed the body checks: the session checks, then the turn streamed. */
async function sessionTurn(request: Request, ctx: ChatRoutesContext, principal: Principal | undefined, sessionId: string, input: AgentInput): Promise<Response> {
  const key = request.headers.get('idempotency-key');
  if (key !== null && !IDEMPOTENCY_KEY.test(key)) return badRequest("The 'Idempotency-Key' header must be 1-255 visible ASCII characters");
  const session = openSession(ctx, sessionId);
  if (session instanceof Response) return session;
  const forbidden = await sessionForbidden(ctx, principal, sessionId, 'chat', session);
  if (forbidden) return forbidden;
  if (key !== null) return idempotentTurn(request, ctx, principal, session, input, key);
  return (await awaitingApproval(session)) ?? turnResponse(request, ctx, (signal) => claimOnCommit(ctx, principal, session, session.stream(input, { signal, principal })));
}

const runChat: RouteHandler = async (request, ctx, _params, principal) => {
  const { sessionId, input, message } = await readJson(request);
  if (typeof sessionId === 'string' && Array.isArray(input) && input.length === 0) return badRequest("Request body's 'input' is empty: send the user's message");
  if (typeof sessionId === 'string' && (typeof input === 'string' ? input : Array.isArray(input))) {
    // the transcript is this session's, so client input is user content only -
    // a caller-sent `system`, `assistant` or `tool` entry would be stored and replayed
    // to the model every turn (the /ui route was hardened the same way).
    // A content-part array has no roles: it is one user message and passes untouched.
    const messages =
      Array.isArray(input) && input.length > 0 && typeof input[0] === 'object' && input[0] !== null && 'role' in input[0]
        ? (input as { role?: unknown }[]).filter((entry) => entry.role === 'user')
        : input;
    if (Array.isArray(messages) && messages.length === 0) {
      return badRequest("Request body's 'input' must contain at least one 'user' message");
    }
    return sessionTurn(request, ctx, principal, sessionId, messages as AgentInput);
  }
  if (typeof message === 'string' && message) {
    if (sessionId !== undefined && typeof sessionId !== 'string') return badRequest("Request body's 'sessionId', if present, must be a string");
    const forbidden = typeof sessionId === 'string' ? await sessionForbidden(ctx, principal, sessionId, 'chat') : undefined;
    if (forbidden) return forbidden;
    if (!warnedLegacy.has(ctx.name)) console.warn(`[${ctx.name}] POST /chat { message } is deprecated: send { sessionId, input } for a session and a streamed turn.`);
    warnedLegacy.add(ctx.name);
    return jsonResponse(200, await ctx.agent().send(message, { ...(ctx.durableMessage && typeof sessionId === 'string' && { sessionId }), principal }), { Deprecation: 'true' });
  }
  return badRequest("Request body must be JSON with 'sessionId' and 'input' strings (or the deprecated 'message')");
};

/**
 * The pending approval `id` when it belongs to `session`, else
 * `undefined`. A pause of this process names its session; one made in
 * another process (or a Worker isolate that is gone) is found through the
 * session's checkpoint, which names its pending approval.
 */
async function approvalOf(agent: SimpleAgent, session: AgentSession, id: string): Promise<PendingApproval | undefined> {
  // A stored pause no session of this process ran yet is listed without a sessionId: check its checkpoint.
  const live = (await agent.approvals.list()).find((candidate) => candidate.id === id && candidate.sessionId !== undefined);
  if (live) return live.sessionId === session.id ? live : undefined;
  const turn = await session.pending();
  // A turn paused on several calls of one step waits on each of them.
  if (turn?.status !== 'awaiting-approval' || !(turn.approvalIds ?? [turn.approvalId]).includes(id)) return undefined;
  // A store without `load()` cannot say whose call it is: the run then counts as having no principal.
  return (await agent.approvals.get(id)) ?? { id, toolCallId: '', toolName: '', args: {}, createdAt: '', sessionId: session.id };
}

/**
 * A pause found through `session`'s checkpoint: `resume()` tells the agent
 * which session it belongs to (docs/sessions.md), so deciding it continues
 * that session.
 */
async function bindRecovered(agent: SimpleAgent, session: AgentSession, id: string): Promise<void> {
  if ((await agent.approvals.list()).some((candidate) => candidate.id === id && candidate.sessionId !== undefined)) return;
  await session.resume().catch((error) => {
    if (!(error instanceof SessionAwaitingApprovalError)) throw error;
  });
}

/**
 * The approvals of each agent a request of this process is deciding now
 * (`<sessionId>/<id>`), from the check that found them pending until their
 * continuation ends: a request that comes in meanwhile lost the race, so it
 * is a `409`, not the `404` of an approval that was never there.
 */
const deciding = new WeakMap<SimpleAgent, Set<string>>();

function decidingOf(agent: SimpleAgent): Set<string> {
  let set = deciding.get(agent);
  if (!set) deciding.set(agent, (set = new Set()));
  return set;
}

function decisionConflict(): Response {
  return jsonResponse(409, { error: 'This approval was decided by another request', code: 'LOUSHO_APPROVAL_CONFLICT' });
}

function notPending(id: string): Response {
  return jsonResponse(404, { error: `No pending approval '${id}' (it was decided already, or the agent was reloaded)`, code: 'LOUSHO_APPROVAL_NOT_FOUND' });
}

/**
 * Reads a decision's stream up to its first event after `run.start`: a
 * decision that lost the race for the approval or approves a sign-in the
 * user has not finished is a `409`; anything else is replayed in full.
 */
async function decisionGate(run: AsyncIterable<AgentEvent>): Promise<Response | AsyncIterable<AgentEvent>> {
  const iterator = run[Symbol.asyncIterator]();
  const head: AgentEvent[] = [];
  let next = await iterator.next();
  while (!next.done && next.value.type === 'run.start') {
    head.push(next.value);
    next = await iterator.next();
  }
  const first = next.done ? undefined : next.value;
  if (first?.type === 'error' && first.error.code === 'LOUSHO_APPROVAL_NOT_FOUND') {
    await iterator.return?.();
    return decisionConflict();
  }
  if (first?.type === 'error' && first.error.name === 'SignInPendingError') {
    await iterator.return?.();
    return jsonResponse(409, { error: first.error.message, code: 'LOUSHO_SIGNIN_PENDING' });
  }
  async function* replay(): AsyncGenerator<AgentEvent> {
    yield* head;
    for (let current = next; !current.done; current = await iterator.next()) yield current.value;
  }
  return replay();
}

const runApproval: RouteHandler = async (request, ctx, [sessionId, id], principal) => {
  const session = openSession(ctx, sessionId);
  if (session instanceof Response) return session;
  const { approved, note, answer } = await readJson(request);
  if (typeof answer !== 'string' && typeof approved !== 'boolean') {
    return jsonResponse(400, { error: "Request body must be JSON with 'approved' (and optional 'note') or 'answer'", code: 'LOUSHO_APPROVAL_DECISION_INVALID' });
  }
  const forbidden = await sessionForbidden(ctx, principal, sessionId, 'approve', session);
  if (forbidden) return forbidden;
  const agent = ctx.agent();
  const inFlight = decidingOf(agent);
  const decision = `${sessionId}/${id}`;
  // Checked before the lookup, which waits for the session's running continuation.
  if (inFlight.has(decision)) return decisionConflict();
  // Only an approval of the session in the URL; another session's is as unknown as a decided one.
  const approval = await approvalOf(agent, session, id);
  if (!approval) return inFlight.has(decision) ? decisionConflict() : notPending(id);
  if (!(await (ctx.authorizeApproval ?? callerOwnsApproval)({ principal, sessionId, approval }))) {
    return jsonResponse(403, { error: 'Not allowed to decide this approval', code: 'LOUSHO_APPROVAL_FORBIDDEN' });
  }
  // `answer` decides a question only - an answer posted to a tool-call or
  // sign-in pause must not silently resolve it. `approved`+`note` is the
  // resolve path: on a question pause it answers (`note`) or declines
  // (`approved: false`), on a sign-in the resolve's own 409 applies. Checked
  // after authorization, so a refused caller learns nothing of the pause's kind.
  const kind = describeApproval(approval).kind ?? 'tool';
  if (typeof answer === 'string' && kind !== 'question') {
    return jsonResponse(400, {
      error: "This approval is not a question: send 'approved'",
      code: 'LOUSHO_APPROVAL_KIND_MISMATCH',
    });
  }
  if (inFlight.has(decision)) return decisionConflict();
  inFlight.add(decision);
  let gate: Awaited<ReturnType<typeof decide>>;
  try {
    gate = await decide(request, ctx, agent, session, id, { answer, approved, note }, principal);
  } catch (error) {
    inFlight.delete(decision);
    throw error;
  }
  if (gate instanceof Response) {
    inFlight.delete(decision);
    return gate;
  }
  return sseResponse(request, ctx, () => releasing(gate, () => void inFlight.delete(decision)), gate.controller);
};

/** Binds a recovered pause to `session` and starts the decision's continuation, gated by {@link decisionGate}. */
async function decide(
  request: Request,
  ctx: ChatRoutesContext,
  agent: SimpleAgent,
  session: AgentSession,
  id: string,
  { answer, approved, note }: Record<string, unknown>,
  principal: Principal | undefined
): Promise<Response | (AsyncIterable<AgentEvent> & { controller: AbortController })> {
  await bindRecovered(agent, session, id);
  // The continuation streams live (decided call, text deltas, a further pause, run.done).
  // The caller route auth accepted is the approver (`ctx.approval.by`); the run keeps its own principal.
  const controller = new AbortController();
  // By default the decided call runs to its end even when the client leaves (sseResponse).
  if (disconnectAborts(ctx)) request.signal.addEventListener('abort', () => controller.abort());
  const run =
    typeof answer === 'string'
      ? agent.approvals.streamAnswer({ id, answer }, { signal: controller.signal, principal })
      : agent.approvals.streamResolve({ id, approved: approved === true, note: typeof note === 'string' ? note : undefined }, { signal: controller.signal, principal });
  const gate = await decisionGate(run);
  return gate instanceof Response ? gate : Object.assign(gate, { controller });
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/** The small page the browser lands on after a sign-in: no script, every value escaped, never cached. */
function signInPage(status: number, title: string, text: string): Response {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head><body><p>${escapeHtml(text)}</p></body></html>`;
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' },
  });
}

/**
 * `GET /oauth/callback?state&code` (or `&error`): finishes the sign-in
 * with `agent.oauth.complete()` and answers a small HTML page. An unknown,
 * used or expired `state` is 400. The page never shows a query value.
 */
const runOAuthCallback: RouteHandler = async (request, ctx, _params, principal) => {
  const query = new URL(request.url).searchParams;
  const code = query.get('code');
  const error = query.get('error');
  try {
    const result = await ctx.agent().oauth.complete({
      state: query.get('state') ?? '',
      ...(code !== null && { code }),
      ...(error !== null && { error }),
      ...(principal && { principal }),
    });
    ctx.afterSignIn?.(result);
    const name = result.displayName ?? result.provider;
    return result.outcome === 'signed-in'
      ? signInPage(200, 'Signed in', `Signed in to ${name}. You can close this tab.`)
      : signInPage(200, 'Sign-in cancelled', `Sign-in to ${name} was cancelled. You can close this tab.`);
  } catch (failure) {
    const failed = (failure as { code?: unknown } | null)?.code;
    if (failed === 'LOUSHO_OAUTH_STATE_INVALID') return signInPage(400, 'Sign-in failed', 'This sign-in link is invalid, was already used, or expired. Start again from the app.');
    if (failed === 'LOUSHO_OAUTH_TOKEN_EXCHANGE_FAILED') return signInPage(502, 'Sign-in failed', 'The sign-in could not be completed. Start again from the app.');
    console.error(`[${ctx.name}] OAuth callback failed:`, (failure as Error | null)?.message ?? failure);
    return signInPage(500, 'Sign-in failed', 'The sign-in could not be completed. Start again from the app.');
  }
};

const runTranscript: RouteHandler = async (_request, ctx, [sessionId], principal) => {
  const session = openSession(ctx, sessionId);
  if (session instanceof Response) return session;
  return (await sessionForbidden(ctx, principal, sessionId, 'read', session)) ?? jsonResponse(200, { sessionId, messages: await session.load(), pending: await session.pending() });
};

/** The sign-in callback, under any prefix (a proxy may mount the API below a path). */
const OAUTH_CALLBACK = /^(?:\/.*)?\/oauth\/callback$/;

/** Whether `request` is the OAuth callback: a browser redirect, so it carries no API token. */
function isOAuthCallback(request: Request): boolean {
  return request.method === 'GET' && OAUTH_CALLBACK.test(new URL(request.url).pathname);
}

/**
 * Who is completing a sign-in, when the callback request happens to be
 * authenticated (e.g. a session cookie the auth list accepts); `undefined`
 * otherwise. Never a refusal: the callback is open, its `state` protects it.
 * An anonymous principal says nothing about the user, so it is not used.
 */
export async function callbackPrincipal(request: Request, auth: readonly AuthFn[] | AuthFn | undefined): Promise<Principal | undefined> {
  if (auth === undefined) return undefined;
  const outcome = await routeAuth(request, auth);
  return outcome.ok && outcome.principal.authenticator !== 'anonymous' ? outcome.principal : undefined;
}

/** Routes by method and path; path parameters reach the handler as `params` (already URL-decoded). */
const ROUTES: Array<[method: string, pattern: RegExp, handler: RouteHandler]> = [
  ['POST', /^\/chat$/, runChat],
  ['GET', /^\/chat\/([^/]+)$/, runTranscript],
  ['POST', /^\/chat\/([^/]+)\/approvals\/([^/]+)$/, runApproval],
  ['GET', OAUTH_CALLBACK, runOAuthCallback],
];

/**
 * Answers `request` when it is one of the `/chat` routes; resolves `undefined`
 * for any other request, so the host can serve its own routes. A failure before
 * streaming starts answers with a JSON error. `principal` is the caller
 * the host's auth accepted; a new turn runs with it, and a decision on
 * an approval records it as the approver.
 */
export async function handleChatFetch(request: Request, ctx: ChatRoutesContext, principal?: Principal): Promise<Response | undefined> {
  const { pathname } = new URL(request.url);
  for (const [method, pattern, handler] of ROUTES) {
    const match = method === request.method ? pattern.exec(pathname) : null;
    if (!match) continue;
    const refused = handler === runOAuthCallback ? undefined : (hostRefusal(request, ctx) ?? (method === 'POST' ? postRefusal(request, ctx) : undefined));
    if (refused) return refused;
    try {
      return await handler(request, ctx, match.slice(1).map(decodeParam), principal);
    } catch (error) {
      return failureResponse(ctx, error);
    }
  }
  return undefined;
}

/** What guards the deployed API: a bearer token (`LOUSHO_API_TOKEN`), or an auth entry or ordered list (docs/auth.md). */
export type ServeAuth = string | AuthFn | readonly AuthFn[];

/**
 * The whole deployed API: `GET /health` (open), then, when `auth` is set, the
 * auth check (a token string is `apiToken(token)`; a 401 / 403 / 500 is
 * answered here), then the `/chat` routes with the accepted principal, then 404.
 */
export async function serveFetch(request: Request, ctx: ChatRoutesContext, auth?: ServeAuth): Promise<Response> {
  // An empty token fails closed, as on `createRouteHandler()`, instead of serving every route open.
  if (auth === '') throw new SDKError('serveFetch(): `auth` is an empty string. Pass the token, an auth list, or undefined for open routes.', 'LOUSHO_AUTH_CONFIG_INVALID');
  if (request.method === 'GET' && new URL(request.url).pathname === '/health') return textResponse(200, 'ok');
  let principal: Principal | undefined;
  if (isOAuthCallback(request)) {
    // A browser redirect carries no API token; an authenticated one still names who completes the sign-in.
    principal = typeof auth === 'string' ? undefined : await callbackPrincipal(request, auth);
  } else if (auth !== undefined) {
    const outcome = await routeAuth(request, typeof auth === 'string' ? apiToken(auth) : auth);
    if (!outcome.ok) return outcome.response;
    principal = outcome.principal;
  }
  // One bearer token is one caller: every session is that caller's, so the default owner check has nothing to do.
  const routes = typeof auth === 'string' && !ctx.authorizeSession ? { ...ctx, authorizeSession: () => true } : ctx;
  return (await handleChatFetch(request, routes, principal)) ?? textResponse(404, 'not found');
}
