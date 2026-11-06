/**
 * The renderers behind the SuccessCard (AA18): an ok `saveAgent` /
 * `saveAgentUpdate` tool part (a model save) and a `uiEvent.kind ===
 * 'save'` user message (the card's Apply button) each draw one. Both
 * resolve the card's name and readiness rows from the propose part the
 * save points at - for a tool part through `input.proposalId`, for the
 * event through `uiEvent.proposalId` - and derive "already on" from the
 * newest `setAgentEnabled` output in the transcript. A busy part falls
 * back to the quiet `ActivityLine` (`undefined`); a failed save draws an
 * ErrorNote with the failure's `userMessage` (AA17).
 *
 * `AuthorPanel.tsx` imports this module once for its side effect: the
 * registrations at the bottom.
 */
import type { ReactNode } from 'react';
import type { AuthorToolPart, AuthorUserMessage, ProposalKind } from '../../shared/authorWire';
import type { AuthorChat } from './AuthorChatContext';
import { ErrorNote } from './ErrorNote';
import { SuccessCard, type SuccessCardProps } from './SuccessCard';
import { findProposalOutput, lastEnabledOutput, saveOutputOf } from './savedProposal';
import {
  registerToolRenderer,
  registerUiEventRenderer,
  type ToolRenderContext,
} from './toolRenderers';

/**
 * The SuccessCard props both save paths build the same way: `kind` is
 * decided by the caller (the tool name, or the stored card's kind for a
 * uiEvent), while name and `requirements` prefer the stored proposal and
 * fall back to the save's own fields. `enabledNow`/`missingCount` come
 * from the newest ok `setAgentEnabled` part anywhere in the transcript.
 */
function successProps(
  chat: AuthorChat,
  kind: ProposalKind,
  fallback: { agentId: string; name: string; version: number },
  proposalId: string | null
): Omit<SuccessCardProps, 'chat'> {
  const { messages, active } = chat.state;
  const proposal =
    proposalId === null ? null : findProposalOutput(messages, active?.assistant ?? null, proposalId);
  const enabled = lastEnabledOutput(messages, active?.assistant ?? null, fallback.agentId);
  return {
    kind,
    agentId: fallback.agentId,
    name: proposal?.spec.name ?? fallback.name,
    version: fallback.version,
    enabledNow: enabled?.enabled === true,
    missingCount: enabled?.missingRequirements ?? 0,
    requirements: proposal?.requirements ?? [],
  };
}

/**
 * An ok save part draws the card; a busy part keeps the activity line and
 * a failed one draws an ErrorNote with the failure's person-facing
 * `userMessage` (AA17 - a failed save is a card, not a line).
 */
function renderSave(part: AuthorToolPart, ctx: ToolRenderContext): ReactNode | undefined {
  const saved = saveOutputOf(part);
  if (saved !== null) {
    const input = part.input as { proposalId?: unknown } | undefined;
    const proposalId = typeof input?.proposalId === 'string' ? input.proposalId : null;
    const kind: ProposalKind = part.name === 'saveAgent' ? 'create' : 'update';
    const props = successProps(ctx.chat, kind, saved, proposalId);
    return <SuccessCard {...props} chat={ctx.chat} />;
  }
  if (part.state === 'pending') return undefined;
  const failure = part.output as { userMessage?: unknown } | undefined;
  const message = typeof failure?.userMessage === 'string' ? failure.userMessage : "Couldn't save the agent.";
  return <ErrorNote message={message} />;
}

/** A `save` uiEvent draws the same card the button save would have. */
function renderSaveEvent(message: AuthorUserMessage, ctx: { chat: AuthorChat }): ReactNode | undefined {
  const uiEvent = message.uiEvent;
  if (uiEvent === undefined || uiEvent.kind !== 'save') return undefined;
  const proposal = findProposalOutput(
    ctx.chat.state.messages,
    ctx.chat.state.active?.assistant ?? null,
    uiEvent.proposalId
  );
  const kind: ProposalKind = proposal?.kind ?? 'update';
  const props = successProps(
    ctx.chat,
    kind,
    { agentId: uiEvent.agentId, name: uiEvent.agentId, version: uiEvent.version },
    uiEvent.proposalId
  );
  return <SuccessCard {...props} chat={ctx.chat} />;
}

registerToolRenderer('saveAgent', renderSave);
registerToolRenderer('saveAgentUpdate', renderSave);
registerUiEventRenderer('save', renderSaveEvent);
