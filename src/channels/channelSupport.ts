/**
 * What the Slack and Discord channels share (LOU-P5.2): who may approve, the
 * default error report, and the approval reference carried in a button.
 */
import { SDKError } from '../execution/errors';
import type { ChannelContext, ChannelDecision, ChannelErrorContext, ChannelErrorHandler, ChannelInbound, ChannelUser } from './defineChannel';
import type { Principal } from '../auth/types';

/** The tool call an approver is asked about. */
export interface ApproverRequest {
  toolName: string;
  input: Record<string, unknown>;
  sessionId: string;
  /** N10b: who the paused run acts for (the turn's sender), when it has a principal. */
  principal?: Readonly<Principal>;
}

/**
 * Who may click Approve / Deny: a list of platform user ids, or a function
 * deciding per user and request. Omitted: only the user who started the turn.
 */
export type Approvers = readonly string[] | ((user: ChannelUser, request: ApproverRequest) => boolean | Promise<boolean>);

/** A decoded button value: the user who started the turn, and the approval id. */
export interface ApprovalRef {
  starter?: string;
  id: string;
}

/** `starter:id` (platform user ids contain no colon), so a button carries who may approve without any stored state. */
export function encodeApprovalRef(starter: unknown, id: string): string {
  return `${typeof starter === 'string' ? starter : ''}:${id}`;
}

export function decodeApprovalRef(value: string): ApprovalRef {
  const at = value.indexOf(':');
  return { starter: at > 0 ? value.slice(0, at) : undefined, id: value.slice(at + 1) };
}

/** Whether `user` may decide the approval in `ref` (see {@link Approvers}). A function sees the pending call - `ctx.approval` answers from the durable approval store after a restart too - and fails closed when no store knows it. */
export async function mayApprove(approvers: Approvers | undefined, user: ChannelUser | undefined, ref: ApprovalRef, ctx: ChannelContext, sessionKey: string): Promise<boolean> {
  if (!user) return false;
  if (approvers === undefined) return ref.starter === user.id;
  if (typeof approvers !== 'function') return approvers.includes(user.id);
  const pending = await ctx.approval(ref.id);
  if (!pending) return false;
  const request: ApproverRequest = { toolName: pending.toolName, input: pending.args, sessionId: ctx.sessionId(sessionKey), ...(pending.principal && { principal: pending.principal }) };
  return Boolean(await approvers(user, request));
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/** Whether two secrets are equal, in constant time: both are hashed (so the lengths match), then the digests are XOR-compared. Web Crypto only. */
export async function secretsEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  return x.reduce((diff, byte, index) => diff | (byte ^ y[index]), 0) === 0;
}

/** Hands `error` to `onError`, or logs it (channel, stage, session, SDK error code; never a token). Never throws. */
export async function reportChannelError(onError: ChannelErrorHandler | undefined, error: unknown, context: ChannelErrorContext): Promise<void> {
  try {
    if (onError) return await onError(error, context);
    const code = error instanceof SDKError ? ` [${error.code}]` : '';
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${context.channel}] ${context.stage} failed${context.sessionId ? ` (session ${context.sessionId})` : ''}${code}: ${message}`);
  } catch {
    // a failing error handler must not take the request down
  }
}

/**
 * Eve CH-F8: remembers the delivery ids (Telegram `update_id`, GitHub `X-GitHub-Delivery`,
 * Slack `event_id`) of the last `ttlMs` (default 1 hour), at most `max` of them (default 10 000),
 * so a surface's redelivery of a webhook this process already took does not run its turn twice.
 * The returned function answers whether `id` was seen before, and records it. In memory: it covers
 * the redelivery window of one process, not a restart or a second replica.
 */
export function deliveryLog(options: { ttlMs?: number; max?: number } = {}): (id: string | undefined) => boolean {
  const ttlMs = options.ttlMs ?? 60 * 60 * 1000;
  const max = options.max ?? 10_000;
  const seen = new Map<string, number>(); // id -> expiry; insertion order is expiry order
  return (id) => {
    if (id === undefined || id === '') return false;
    const now = Date.now();
    for (const [key, expires] of seen) {
      if (expires > now) break;
      seen.delete(key);
    }
    if (seen.has(id)) return true;
    seen.set(id, now + ttlMs);
    if (seen.size > max) seen.delete(seen.keys().next().value as string);
    return false;
  };
}

/** Eve CH-F6: what a client sees of a channel 500, as on the session routes (A1); the detail goes to `onError`. */
const PUBLIC_ERROR_MESSAGE = 'The request failed. The server log has the details.';

/**
 * Eve CH-F6: the JSON body of a channel request that failed before the surface was answered:
 * a 413 or 400 (bad JSON) keeps its message, a 500 only says it failed (and the error's `code`).
 */
export function channelFailureBody(status: number, error: unknown): Record<string, unknown> {
  if (status !== 500) return { error: (error as Error).message };
  const code = (error as { code?: unknown } | null)?.code;
  return { error: PUBLIC_ERROR_MESSAGE, ...(typeof code === 'string' && code && { code }) };
}

/** Splits `text` into chunks of at most `max` characters, preferably at line breaks (empty text becomes `(no reply)`). */
export function splitText(text: string, max: number): string[] {
  const parts: string[] = [];
  let rest = text || '(no reply)';
  while (rest.length > max) {
    const cut = rest.lastIndexOf('\n', max);
    const at = cut > max / 2 ? cut : max;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, '');
  }
  return [...parts, rest];
}

/**
 * The message `inbound` as the answer to this conversation's pending `ask_question`, if one is waiting
 * (asked in this process, or before a restart given durable stores); else `inbound` itself.
 */
export async function answerPendingQuestion<TEvent>(
  inbound: ChannelInbound<TEvent>,
  questions: Map<string, string>,
  ctx: ChannelContext
): Promise<ChannelInbound<TEvent> | ChannelDecision> {
  const question = questions.get(inbound.sessionKey) ?? (await ctx.pendingQuestion(inbound.sessionKey));
  if (!question) return inbound;
  questions.delete(inbound.sessionKey);
  return { decision: { id: question, answer: typeof inbound.input === 'string' ? inbound.input : '' }, inbound };
}
