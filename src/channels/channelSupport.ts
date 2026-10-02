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

/** Whether `user` may decide the approval in `ref` (see {@link Approvers}). A function sees the pending call, so it fails closed when this process does not know it. */
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
