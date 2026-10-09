/**
 * LOU-X8: ready-made `needsApproval` policies. `always()` and `never()` are
 * the plain booleans; `once()` asks the first time a tool is called in a
 * session and approves its later calls once a human approved one.
 *
 * The "already approved" memory is the transcript itself: resuming an
 * approved call marks its `tool` message (`metadata.approval`), and the
 * transcript is what sessions, checkpoints and approval snapshots already
 * persist, so the memory survives a durable resume in another process.
 */

import type { Message } from '../providers/llm';
import type { ApprovalCheckContext, ApprovalOutcome } from '../types';
import { cyrb53 } from '../utils/cyrb53';

/** A `needsApproval` function that works on any tool. */
export type ApprovalPolicy = (args: unknown, ctx: ApprovalCheckContext) => ApprovalOutcome;

/** Always pause for approval: the same as `needsApproval: true`. */
export function always(): true {
  return true;
}

/** Never pause for approval: the same as `needsApproval: false`. */
export function never(): false {
  return false;
}

/**
 * Asks the first time the tool is called in a session; once a human approves
 * a call, later calls of the tool in that session run without asking. A
 * rejection is not remembered, nor is an approval given by a
 * `createAgent({ approve })` callback (Eve TOOLS-F19): the callback is asked
 * again each time, unless the decision said `remember: 'session'`. `per: 'args'` remembers approvals per tool and
 * arguments instead (the next call with different arguments asks again).
 *
 * @example
 * ```ts
 * import { defineTool, once } from '@lousho/build-ai-agent';
 * import { z } from 'zod';
 *
 * const deploy = defineTool({
 *   name: 'deploy',
 *   description: 'Deploy a service',
 *   input: z.object({ service: z.string() }),
 *   needsApproval: once({ per: 'args' }),
 *   execute: async ({ service }) => `deployed ${service}`,
 * });
 * ```
 */
export function once(options: { per?: 'tool' | 'args' } = {}): ApprovalPolicy {
  return (args, { toolName, messages }) => {
    const key = options.per === 'args' ? argsKey(args) : undefined;
    const approved = messages.some((m) => m.role === 'tool' && m.toolName === toolName && wasApproved(m, key));
    return approved ? 'approve' : 'ask';
  };
}

/**
 * The `metadata` recorded on the `tool` message of an approved call.
 * Eve TOOLS-F19: `automatic` when an `approve` callback (not a human)
 * approved it, `remember` when the decision asked to approve identical calls
 * for the rest of the session.
 */
export function approvalMarker(args: unknown, options: { automatic?: boolean; remember?: 'session' } = {}): Record<string, unknown> {
  return {
    approval: { approved: true, args: argsKey(args), ...(options.automatic && { automatic: true }), ...(options.remember && { remember: options.remember }) },
  };
}

interface ApprovalMark {
  approved?: unknown;
  args?: unknown;
  automatic?: unknown;
  remember?: unknown;
}

const markOf = (message: Message): ApprovalMark | undefined => message.metadata?.approval as ApprovalMark | undefined;

function wasApproved(message: Message, key: string | undefined): boolean {
  const approval = markOf(message);
  // Eve TOOLS-F19: an `approve` callback's yes counts only with `remember`. (Markers written before it have no `automatic`.)
  if (approval?.approved !== true || (approval.automatic === true && approval.remember === undefined)) return false;
  return key === undefined || approval.args === key;
}

/**
 * Eve TOOLS-F19: whether an earlier call of `toolName` in `messages` was
 * approved with `remember: 'session'` and the same `args` - the tool's
 * `needsApproval` then does not ask again.
 */
export function rememberedApproval(messages: readonly Message[], toolName: string, args: unknown): boolean {
  let key: string | undefined;
  return messages.some((message) => {
    if (message.role !== 'tool' || message.toolName !== toolName) return false;
    const approval = markOf(message);
    if (approval?.approved !== true || approval.remember !== 'session') return false;
    key ??= argsKey(args);
    return approval.args === key;
  });
}

/** A stable hash of `args`: the same for equal values, whatever their key order. */
function argsKey(args: unknown): string {
  return cyrb53(JSON.stringify(args, sortKeys) ?? '');
}

function sortKeys(_key: string, value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}


