import type { ApproveToolCall } from '@lousho/build-ai-agent';
import { autoApproveSenders, findDraft, getMessage } from './lib/mailstore';

/**
 * An OPTIONAL standing-policy approver, deliberately NOT wired into
 * agent.json: the kit's contract is that a human reviews every send. With no
 * approver, the `ask` permission on `send_reply` pauses the run and the human
 * decides through `agent.approvals.resolve()`, a channel's
 * `/channels/<name>/approvals/:id` route, or the chat REPL's [y/N] prompt.
 *
 * A headless deployment that wants autonomy can add `"approve": "approve.ts"`
 * to agent.json. This approver then decides every pause: `send_reply` goes
 * out only to addresses or domains on the standing allowlist
 * (`data/auto-approve.json` or INBOX_TRIAGE_AUTO_APPROVE, comma-separated);
 * everything else is refused to the model, which reports "held for human
 * review" instead. An approver cannot abstain - whatever it returns IS the
 * decision - so wire it in only when that trade-off is intended.
 */

/** Who a send_reply would reach: the draft's recipient, else the original message's sender. */
async function recipientOf(args: Record<string, unknown>): Promise<string> {
  if (typeof args.draftId === 'string') {
    const draft = await findDraft(args.draftId);
    if (draft) return draft.to.toLowerCase();
  }
  if (typeof args.messageId === 'string') {
    try {
      return (await getMessage(args.messageId)).from.toLowerCase();
    } catch {
      return '';
    }
  }
  return '';
}

/** Whether `to` matches an allowlist entry (a full address or a '@domain' / bare domain). */
function allowlisted(to: string, entries: readonly string[]): boolean {
  return entries.some((entry) => {
    const normalized = entry.startsWith('@') ? entry.slice(1) : entry;
    return normalized.includes('@') ? to === normalized : to.endsWith(`@${normalized}`);
  });
}

const approve: ApproveToolCall = async ({ toolName, args }) => {
  if (toolName !== 'send_reply') return false;
  const to = await recipientOf(args);
  return to !== '' && allowlisted(to, await autoApproveSenders());
};

export default approve;
