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
 * rejection is not remembered. `per: 'args'` remembers approvals per tool and
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

/** The `metadata` recorded on the `tool` message of a call a human approved. */
export function approvalMarker(args: unknown): Record<string, unknown> {
  return { approval: { approved: true, args: argsKey(args) } };
}

function wasApproved(message: Message, key: string | undefined): boolean {
  const approval = message.metadata?.approval as { approved?: unknown; args?: unknown } | undefined;
  return approval?.approved === true && (key === undefined || approval.args === key);
}

/** A stable hash of `args`: the same for equal values, whatever their key order. */
function argsKey(args: unknown): string {
  return cyrb53(JSON.stringify(args, sortKeys) ?? '');
}

function sortKeys(_key: string, value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}


