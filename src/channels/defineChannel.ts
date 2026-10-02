/**
 * Channels (LOU-P7): one definition per surface (an HTTP API, a webhook,
 * Slack, Discord, ...) that says how an inbound request is authenticated,
 * which conversation it belongs to, and how the agent's reply (or an
 * approval it pauses on) goes back to that surface. `mountChannels()` runs
 * them: verify -> parse -> a session turn -> reply.
 *
 * No runtime `node:*` import here, so a Worker host can reuse the contract.
 */
import type { AgentInput } from '../providers/content';
import type { ExecutionResult } from '../execution/AgentExecutor';
import type { AgentEvent } from '../execution/agentEvents';
import type { PendingApproval } from '../execution/ApprovalGate';
import { ConfigurationError } from '../execution/errors';

/** An inbound request as a channel sees it: framework-free, with the exact body bytes. */
export interface ChannelRequest {
  method: string;
  /** Path and query, e.g. `/channels/http?x=1`. */
  url: string;
  /** Header names are lower-case (as in `node:http`). */
  headers: Record<string, string | string[] | undefined>;
  /** The exact body bytes: verify signatures over these, never over re-serialized JSON. */
  rawBody: Uint8Array;
  /** The body decoded as UTF-8. */
  text: string;
  /** The host's own request object (an `http.IncomingMessage` under `mountChannels()`). */
  native?: unknown;
}

/** What `verify` may return instead of a boolean: `reason` is logged, never sent to the caller. */
export interface ChannelAuthResult {
  ok: boolean;
  reason?: string;
}

/** One inbound message, mapped to a conversation. */
export interface ChannelInbound<TEvent = unknown> {
  /** The conversation on the surface (a thread, a chat, a user); equal keys share a session. */
  sessionKey: string;
  input: AgentInput;
  metadata?: Record<string, unknown>;
  /** Where the reply goes on the surface (a channel id, a response URL, ...). */
  replyTo: unknown;
  /** The parsed surface event, for `reply` / `onApproval`. */
  event?: TEvent;
}

/** Writes the still-open HTTP response of the request being handled (the first call wins). */
export type ChannelRespond = (status: number, body: unknown) => void;

/** A decision on a pause: `{ approved, note? }` for a tool call, `{ answer }` for a question. */
export interface ChannelApprovalDecision {
  id: string;
  approved?: boolean;
  note?: string;
  answer?: string;
}

/** Who clicked a button on a surface: the surface's own user id, plus a name and roles where it has them. */
export interface ChannelUser {
  id: string;
  name?: string;
  roles?: string[];
}

/**
 * What `parse` returns for a request that decides a pause (a button click) instead of starting a turn.
 * With `inbound` (the conversation as the click itself names it), a pause that a restarted process
 * no longer remembers is still delivered to the right place; `approver` is who decided.
 */
export interface ChannelDecision {
  decision: ChannelApprovalDecision;
  inbound?: ChannelInbound;
  approver?: ChannelUser;
}

/** Where a failure after the surface was answered happened. */
export interface ChannelErrorContext {
  channel: string;
  stage: 'parse' | 'turn' | 'reply' | 'approval';
  sessionId?: string;
}

/** Called for a failure after the request was acknowledged (see `Channel.onError`); never throws out of the handler. */
export type ChannelErrorHandler = (error: unknown, context: ChannelErrorContext) => void | Promise<void>;

/** What `parse` may ask the host about: the agent's own state, so a channel keeps none of its own. */
export interface ChannelContext {
  /** The pending approval `id` this process knows, if any. */
  approval(id: string): Promise<PendingApproval | undefined>;
  /** The session id `sessionKey` maps to. */
  sessionId(sessionKey: string): string;
  /** Whether a session was already saved for `sessionKey` (e.g. "the bot is active in this thread"). */
  hasSession(sessionKey: string): Promise<boolean>;
}

/** What `reply` gets. */
export interface ChannelReplyContext<TEvent = unknown> {
  inbound: ChannelInbound<TEvent>;
  /** The session the turn ran in. */
  sessionId: string;
  /** The reply text: the text so far while `partial`, else the final text (or the approval prompt). */
  text: string;
  /** `true` for an in-progress update (only with `stream: true`). */
  partial?: boolean;
  /** The turn's result, on the final reply. */
  result?: ExecutionResult;
  /** The turn's events, on the final reply of a streamed turn. */
  events?: AgentEvent[];
  /** Set when the turn paused on this approval or question. */
  approval?: PendingApproval;
  /** Present while the inbound HTTP request is still open (absent for `resolveApproval()` calls). */
  respond?: ChannelRespond;
}

/** What `onApproval` gets: the pause to render, with a default text prompt in `text`. */
export interface ChannelApprovalContext<TEvent = unknown> extends ChannelReplyContext<TEvent> {
  approval: PendingApproval;
}

/** A surface the agent talks through. Build one with `defineChannel()`. */
export interface Channel<TEvent = unknown> {
  /** Route segment (`POST <basePath>/<name>`): letters, digits, `_` and `-`. */
  name: string;
  /** Call `reply` with `partial: true` and the text so far as the model writes. Default `false`. */
  stream?: boolean;
  /** Authenticates the request (signature, token, ...); `false` answers 401. Default: accept. */
  verify?(req: ChannelRequest): Promise<boolean | ChannelAuthResult>;
  /**
   * The message in `req`; `{ decision }` to resolve a pause this channel's turn
   * stopped on (a button click); or `null` to acknowledge it without a turn (a
   * bot echo, a retry). Call `respond` to answer the request before the turn
   * runs (a surface that needs an answer within seconds, a handshake).
   */
  parse(req: ChannelRequest, respond: ChannelRespond, ctx: ChannelContext): Promise<ChannelInbound<TEvent> | ChannelDecision | null>;
  /** Delivers the agent's reply to the surface. */
  reply(ctx: ChannelReplyContext<TEvent>): Promise<void>;
  /** Renders a pause (buttons, a form, ...). Default: `reply` with the text prompt. */
  onApproval?(ctx: ChannelApprovalContext<TEvent>): Promise<void>;
  /** Receives failures after the request was acknowledged (reply delivery, the turn, a continuation). Default: `mountChannels({ onError })`, else `console.error`. */
  onError?: ChannelErrorHandler;
  /** The session for an inbound message. Default: `` `${name}:${sessionKey}` ``. */
  sessionId?(inbound: ChannelInbound<TEvent>): string;
}

const CHANNEL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Defines a channel. The definition is returned as is, after checking its name.
 *
 * @example
 * ```ts
 * import { defineChannel } from '@lousho/build-ai-agent';
 *
 * const sms = defineChannel({
 *   name: 'sms',
 *   async parse(req) {
 *     const { from, body } = JSON.parse(req.text) as { from: string; body: string };
 *     return { sessionKey: from, input: body, replyTo: from };
 *   },
 *   async reply({ inbound, text }) {
 *     console.log(`to ${String(inbound.replyTo)}: ${text}`);
 *   },
 * });
 * ```
 */
export function defineChannel<TEvent = unknown>(channel: Channel<TEvent>): Channel<TEvent> {
  if (!CHANNEL_NAME.test(channel.name)) {
    throw new ConfigurationError(`Invalid channel name ${JSON.stringify(channel.name)}: use 1-64 characters from A-Z, a-z, 0-9, '_' and '-'.`, 'name');
  }
  return channel;
}

/** A short, stable hash (53-bit FNV-style mix) so a sanitized session id stays unique. */
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * The session id for `inbound`: `channel.sessionId(inbound)`, by default
 * `${name}:${sessionKey}`. Session ids allow only `A-Za-z0-9_-` (they become
 * file names), so any other key has those characters replaced by `_` and a
 * hash of the key appended: `http:user/1` becomes `http_user_1-<hash>`.
 */
export function channelSessionId<TEvent>(channel: Channel<TEvent>, inbound: ChannelInbound<TEvent>): string {
  const key = channel.sessionId ? channel.sessionId(inbound) : `${channel.name}:${inbound.sessionKey}`;
  return SESSION_ID.test(key) ? key : `${key.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 112)}-${hash(key)}`;
}

/** The default text for a pause: the question (with numbered options), or the tool call to approve. */
export function approvalPrompt(approval: PendingApproval): string {
  if (approval.question) {
    const options = (approval.question.options ?? []).map((option, i) => `\n${i + 1}. ${option}`).join('');
    return `${approval.question.text}${options}\n(answer id: ${approval.id})`;
  }
  return `Approve ${approval.toolName} ${JSON.stringify(approval.args)}? (approval id: ${approval.id})`;
}

/** Builds a `ChannelRequest` from a host request (`node:http` or any object with the same fields). */
export function toChannelRequest(
  req: { method?: string; url?: string; headers: Record<string, string | string[] | undefined> },
  rawBody: Uint8Array
): ChannelRequest {
  return { method: req.method ?? 'POST', url: req.url ?? '/', headers: req.headers, rawBody, text: new TextDecoder().decode(rawBody), native: req };
}
