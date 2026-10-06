import type { AgentHook } from '@lousho/build-ai-agent';
import { findDraft } from './lib/mailstore';

/**
 * The kit's hooks (pointed at by `agent.json`'s `hooks`):
 *
 * - loop-guard: denies a tool call the model already made twice with the same
 *   arguments (ported from coding-kit);
 * - output-cap: cuts long tool results so a fat newsletter can't flood the
 *   context;
 * - no-placeholder-send: triage-specific guardrail - refuses a `send_reply`
 *   whose effective body still contains a `[PLACEHOLDER]` before the approval
 *   pause even happens, so a human is never asked to approve half-finished
 *   mail.
 */

/**
 * Deny a tool call the model already made `maxRepeats` times with the same
 * arguments. `exempt` names approval-gated tools: `send_reply` pauses for a
 * human and its preToolCall fires again when the approved call resumes, so
 * counting it would let the guard overrule a human's explicit approval.
 */
export function loopGuard(maxRepeats = 2, exempt: readonly string[] = []): AgentHook {
  const seen = new Map<string, number>();
  const skip = new Set(exempt);
  return {
    name: 'loop-guard',
    preToolCall(ctx) {
      if (skip.has(ctx.toolName)) return undefined;
      const key = `${ctx.sessionId ?? ''}:${ctx.toolName}:${JSON.stringify(ctx.args)}`;
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      if (count > maxRepeats) {
        return { deny: `You already called ${ctx.toolName} with these arguments ${maxRepeats} times. Try something else.` };
      }
      return undefined;
    },
  };
}

/** Cut long tool results so they do not flood the context. */
export function outputCap(maxChars = 4_000): AgentHook {
  return {
    name: 'output-cap',
    postToolCall(_ctx, result) {
      const text = typeof result.result === 'string' ? result.result : JSON.stringify(result.result ?? '');
      if (text.length <= maxChars) return undefined;
      return { result: `${text.slice(0, maxChars)}\n[output cut at ${maxChars} of ${text.length} chars]` };
    },
  };
}

/** The body a send_reply would actually send: the inline `body`, else the referenced draft's. */
async function outgoingBody(args: Record<string, unknown>): Promise<string> {
  if (typeof args.body === 'string') return args.body;
  if (typeof args.draftId === 'string') return (await findDraft(args.draftId))?.body ?? '';
  return '';
}

const PLACEHOLDER = /\[[A-Za-z][A-Za-z _-]{1,40}\]/;

/** Refuse a send whose body still has a [PLACEHOLDER] or is empty - before the approval pause. */
export function noPlaceholderSend(): AgentHook {
  return {
    name: 'no-placeholder-send',
    async preToolCall(ctx) {
      if (ctx.toolName !== 'send_reply') return undefined;
      const body = await outgoingBody(ctx.args);
      const placeholder = PLACEHOLDER.exec(body);
      if (body.trim() === '') {
        return { deny: 'send_reply has no body. Write the reply with draft_reply first, or pass a complete body.' };
      }
      if (placeholder) {
        return {
          deny: `The reply still contains the placeholder ${placeholder[0]}. Fill it in (or remove it) and ask again - a human should not be paged for half-finished mail.`,
        };
      }
      return undefined;
    },
  };
}

export default [loopGuard(2, ['send_reply']), noPlaceholderSend(), outputCap()];
