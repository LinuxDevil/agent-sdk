/**
 * The tool-part renderers for `proposeAgent` and `proposeAgentUpdate`
 * (AA16): every ok propose part draws a {@link ProposalCard}, and exactly
 * one card in the whole conversation - the `actionableProposalId` the
 * transcript walk returns - gets the Apply footer. A busy or failed
 * propose part falls back to the quiet `ActivityLine` (`undefined`), a
 * draft-review bounce draws nothing (`null`), and a superseded create
 * card not in `visibleCreateProposalIds` is hidden while superseded
 * update cards stay as history.
 *
 * `AuthorPanel.tsx` imports this module once for its side effect: the two
 * `registerToolRenderer` calls at the bottom.
 */
import type { ReactNode } from 'react';
import {
  isDraftReviewFailure,
  type AuthorToolPart,
  type ProposalOutput,
} from '../../shared/authorWire';
import type { AuthorChat } from './AuthorChatContext';
import { ProposalCard, type ProposalCardProps } from './ProposalCard';
import {
  cardState,
  proposalActionState,
  type ProposalActionState,
} from './proposalActionState';
import { focusProposalCard } from './proposalFocus';
import { registerToolRenderer, type ToolRenderContext } from './toolRenderers';

/** The Apply footer's disabled copy, in precedence order. */
function disabledReason(chat: AuthorChat, s: ProposalActionState): string | null {
  if (chat.isStreaming) return 'Wait for the Author to finish replying';
  if (s.hasPendingClientRequest) return 'Answer the open card first';
  return null;
}

/** The `apply` prop only the actionable card gets. */
function applyFor(
  proposal: ProposalOutput,
  s: ProposalActionState,
  ctx: ToolRenderContext
): NonNullable<ProposalCardProps['apply']> {
  const error = ctx.chat.state.saveErrors[proposal.proposalId];
  return {
    onApply: () => void ctx.chat.apply(proposal.proposalId),
    saving: ctx.chat.state.saving?.proposalId === proposal.proposalId,
    disabledReason: disabledReason(ctx.chat, s),
    ...(error !== undefined ? { error } : {}),
  };
}

/**
 * The save-error "Show the newer proposal" action: scroll to the card the
 * gate named, or - when the optimistic transcript has not caught up -
 * reconcile the session first, then retry once.
 */
function showNewer(chat: AuthorChat, id: string): void {
  if (focusProposalCard(id) || chat.state.sessionId === null) return;
  const sessionId = chat.state.sessionId;
  void chat
    .openSession(sessionId)
    .catch(() => undefined)
    .then(() => {
      setTimeout(() => {
        focusProposalCard(id);
      }, 0);
    });
}

/** Both propose tools draw the same card; the output's `kind` decides what it shows. */
function renderProposal(part: AuthorToolPart, ctx: ToolRenderContext): ReactNode | null | undefined {
  if (part.state !== 'done') return undefined; // busy part → the activity line
  if (isDraftReviewFailure(part.output)) return null; // the review bounce renders nothing
  const output = part.output as ProposalOutput | { ok?: unknown } | undefined;
  if (output === undefined || output === null || output.ok !== true) return undefined; // failed → activity line
  const proposal = output as ProposalOutput;
  const s = proposalActionState(ctx.chat.state.messages, ctx.chat.state.active?.assistant);
  const state = cardState(proposal.proposalId, s);
  // Superseded creates drop out entirely; superseded updates stay as history.
  if (state === 'superseded' && proposal.kind === 'create' && !s.visibleCreateProposalIds.has(proposal.proposalId)) {
    return null;
  }
  return (
    <ProposalCard
      output={proposal}
      state={state}
      apply={state === 'actionable' ? applyFor(proposal, s, ctx) : undefined}
      onShowNewer={(id) => showNewer(ctx.chat, id)}
    />
  );
}

registerToolRenderer('proposeAgent', renderProposal);
registerToolRenderer('proposeAgentUpdate', renderProposal);
