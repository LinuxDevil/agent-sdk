/**
 * What the Slack and Discord channels share (LOU-P5.2): who may approve, the
 * default error report, and the approval reference carried in a button.
 */
import { SDKError } from '../execution/errors';
import type { ChannelContext, ChannelErrorContext, ChannelErrorHandler, ChannelUser } from './defineChannel';

/** The tool call an approver is asked about. */
export interface ApproverRequest {
  toolName: string;
  input: Record<string, unknown>;
  sessionId: string;
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
  return pending ? Boolean(await approvers(user, { toolName: pending.toolName, input: pending.args, sessionId: ctx.sessionId(sessionKey) })) : false;
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
