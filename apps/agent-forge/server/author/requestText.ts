/**
 * `requestTextForProposal` — the user words behind an Author card
 * (PLAN §8.3, L05): the text of the last `role: 'user'` message without
 * `uiEvent` that comes before the assistant message holding the tool
 * part with `toolCallId === proposalId`. `uiEvent` user messages are
 * app-written markers ("[UI event] User applied proposal …"), never
 * something the user asked for, so they are skipped. `null` when the
 * proposal is not in the transcript or no user text precedes it.
 *
 * The result is already cut to {@link VERSION_REQUEST_MAX_CHARS} through
 * `clampVersionText`; `VersionStore.write` clamps again on the way in,
 * which is idempotent. Compute this before taking the agent lock.
 */
import type { AuthorMessage } from '../../shared/authorWire';
import { clampVersionText, VERSION_REQUEST_MAX_CHARS } from '../storage/versionText';

/**
 * The last non-empty user text before the assistant message holding
 * `proposalId`, cut to {@link VERSION_REQUEST_MAX_CHARS} chars ('…' when
 * cut). `null` when no card carries the id or no user text precedes it.
 */
export function requestTextForProposal(messages: readonly AuthorMessage[], proposalId: string): string | null {
  let lastUserText: string | null = null;
  for (const message of messages) {
    if (message.role === 'user') {
      if (message.uiEvent === undefined && message.text.trim() !== '') lastUserText = message.text;
      continue;
    }
    const holdsCard = message.parts.some((part) => part.type === 'tool' && part.toolCallId === proposalId);
    if (holdsCard) {
      return lastUserText === null ? null : clampVersionText(lastUserText, VERSION_REQUEST_MAX_CHARS);
    }
  }
  return null;
}
