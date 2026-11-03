/**
 * The save gate's refusal copy (PLAN §8.3 "Save refuses when ...", research
 * §5.2): one builder per failure code the proposal gate can return. Like
 * every Author tool failure, `error` and `next` are model-facing - they may
 * name tools and ids so the model can recover - while `userMessage` is
 * person-facing plain words and never contains a tool name or an id
 * (`__tests__/failures.test.ts` scans for them).
 */
import type { AuthorToolFailure, ProposalKind } from '../../../shared/authorWire';
import { toolFailure } from '../tools/failure';

/**
 * The propose tool that shows a card for each proposal kind: `proposeAgent`
 * for a new agent, `proposeAgentUpdate` for an edit. Declared here because
 * the copy below names it; `gate.ts` re-exports it so the whole save-gate
 * surface imports from one module.
 */
export const PROPOSE_TOOL = { create: 'proposeAgent', update: 'proposeAgentUpdate' } as const;

/**
 * `UNANSWERED`: the card was shown in this very turn, so the user cannot
 * have answered it yet. `kind` keeps the signature uniform with the sibling
 * builders (callers always pass `identity.kind`); this refusal's copy is
 * the same for creates and updates.
 */
export function unansweredFailure(_kind: ProposalKind): AuthorToolFailure {
  return toolFailure(
    'UNANSWERED',
    'The proposal card was shown in this turn, so the user has not answered it yet.',
    'Review the proposal and confirm it before it is saved.',
    'End your turn now and let the user read the card. Save only after they confirm in a later message. Never say it was saved.'
  );
}

/** `NO_PROPOSAL`: no open card exists - it was discarded or never shown. */
export function noProposalFailure(kind: ProposalKind): AuthorToolFailure {
  return toolFailure(
    'NO_PROPOSAL',
    'There is no open proposal card to save.',
    "There's nothing to save: this proposal was discarded or never shown. Ask the Author for a new proposal.",
    `Call ${PROPOSE_TOOL[kind]}, show the card, and wait for the user's reply before saving.`
  );
}

/** `ALREADY_SAVED`: the newest card was already saved, by the model or by the user's Apply button. */
export function alreadySavedFailure(): AuthorToolFailure {
  return toolFailure(
    'ALREADY_SAVED',
    "The newest proposal card was already saved, by you or by the user's Apply button.",
    'This proposal has already been saved. Ask the Author for a new proposal if you want another change.',
    'Tell the user it is already saved. For a further change, propose it and wait for their reply.'
  );
}

/** `UNKNOWN_PROPOSAL`: no successful propose part carries `proposalId` in this chat. */
export function unknownProposalFailure(kind: ProposalKind, proposalId: string): AuthorToolFailure {
  return toolFailure(
    'UNKNOWN_PROPOSAL',
    `No ${PROPOSE_TOOL[kind]} card with proposalId "${proposalId}" exists in this chat.`,
    "This proposal is no longer part of this chat, so it can't be saved. Ask the Author to propose it again.",
    `Copy the proposalId verbatim from the successful ${PROPOSE_TOOL[kind]} result the user agreed to. Never invent one.`
  );
}

/** `STALE_PROPOSAL`: `proposalId` is a real card but a newer one replaced it; only the newest can save. */
export function staleProposalFailure(proposalId: string, latestProposalId: string): AuthorToolFailure {
  return toolFailure(
    'STALE_PROPOSAL',
    `Proposal "${proposalId}" is not the newest card; "${latestProposalId}" replaced it. Only the newest card can be saved.`,
    'A newer proposal replaced this one, and only the newest proposal can be saved. Review the newer proposal and apply that one instead.',
    'If the user agreed to the newest card, save it by its proposalId. Otherwise ask which version they want.',
    { latestProposalId }
  );
}

/** `WRONG_AGENT`: `proposalId` is an update card for `other`, not for `agentId`. */
export function wrongAgentFailure(proposalId: string, other: string, agentId: string): AuthorToolFailure {
  return toolFailure(
    'WRONG_AGENT',
    `Proposal "${proposalId}" changes agent "${other}", not "${agentId}".`,
    "This proposal changes a different agent, so it can't be saved here.",
    "Save it with the agentId it was proposed for, or propose this agent's change first."
  );
}

/** `AMBIGUOUS_PROPOSAL`: `proposalId` names more than one tool call, so the card cannot be identified. */
export function ambiguousProposalFailure(kind: ProposalKind, proposalId: string): AuthorToolFailure {
  return toolFailure(
    'AMBIGUOUS_PROPOSAL',
    `proposalId "${proposalId}" names more than one tool call in this chat, so the card cannot be identified.`,
    "This proposal can't be told apart from another step in this chat. Ask the Author to propose it again.",
    `Call ${PROPOSE_TOOL[kind]} again with the configuration the user agreed to, let them confirm the new card, and save that one.`
  );
}
