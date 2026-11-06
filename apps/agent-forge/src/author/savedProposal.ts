/**
 * Transcript lookups the SuccessCard renderers share (AA18). The
 * transcript is the proposal store, so a save - model tool part or
 * button `uiEvent` - finds its card's name, kind and readiness rows by
 * walking the same messages {@link proposalActionState} walks: the
 * settled list plus the live assistant message.
 */
import type {
  AuthorAssistantMessage,
  AuthorMessage,
  AuthorToolPart,
  ProposalOutput,
  SetEnabledOutput,
} from '../../shared/authorWire';

const PROPOSE_NAMES = new Set(['proposeAgent', 'proposeAgentUpdate']);

/** A tool part settled successfully (`done` + `output.ok === true`). */
function okPart(part: AuthorToolPart): boolean {
  return (
    part.state === 'done' &&
    typeof part.output === 'object' &&
    part.output !== null &&
    (part.output as { ok?: unknown }).ok === true
  );
}

/** `messages` then `active`, in transcript order. */
function* assistantMessages(
  messages: readonly AuthorMessage[],
  active: AuthorAssistantMessage | null
): Generator<AuthorAssistantMessage> {
  for (const message of messages) if (message.role === 'assistant') yield message;
  if (active !== null) yield active;
}

/**
 * The `ok: true` output of the propose part whose `toolCallId` is
 * `proposalId`, or `null` when no card carries it (a save uiEvent whose
 * proposal left the transcript). It carries the card's `kind`,
 * `spec.name` and `requirements` - everything a SuccessCard needs that
 * the save result does not repeat.
 */
export function findProposalOutput(
  messages: readonly AuthorMessage[],
  active: AuthorAssistantMessage | null,
  proposalId: string
): ProposalOutput | null {
  for (const message of assistantMessages(messages, active)) {
    for (const part of message.parts) {
      if (part.type !== 'tool' || !PROPOSE_NAMES.has(part.name) || part.toolCallId !== proposalId) continue;
      if (!okPart(part)) continue;
      return part.output as ProposalOutput;
    }
  }
  return null;
}

/**
 * The newest ok `setAgentEnabled` output naming `agentId`, or `null`
 * when the model never flipped the switch. Scanning the whole transcript
 * (not only parts after the save) is safe: the enable route only touches
 * agents this chat created, and the last result is the current state -
 * a later disable writes `enabled: false`.
 */
export function lastEnabledOutput(
  messages: readonly AuthorMessage[],
  active: AuthorAssistantMessage | null,
  agentId: string
): SetEnabledOutput | null {
  let found: SetEnabledOutput | null = null;
  for (const message of assistantMessages(messages, active)) {
    for (const part of message.parts) {
      if (part.type !== 'tool' || part.name !== 'setAgentEnabled' || !okPart(part)) continue;
      const output = part.output as SetEnabledOutput;
      if (output.agentId === agentId) found = output;
    }
  }
  return found;
}

/** The fields a SuccessCard reads off an ok `saveAgent`/`saveAgentUpdate` output, or `null` for any other shape. */
export function saveOutputOf(part: AuthorToolPart): { agentId: string; name: string; version: number } | null {
  if (part.state !== 'done') return null;
  const output = part.output as { ok?: unknown; agentId?: unknown; name?: unknown; version?: unknown } | undefined;
  if (
    output === undefined ||
    output === null ||
    output.ok !== true ||
    typeof output.agentId !== 'string' ||
    typeof output.name !== 'string' ||
    typeof output.version !== 'number'
  ) {
    return null;
  }
  return { agentId: output.agentId, name: output.name, version: output.version };
}
