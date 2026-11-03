/**
 * The per-turn proposal record (PLAN §8.3): which identity keys the
 * Author proposed, discarded or saved THIS turn, plus the review-round
 * counter AA12's draft review uses. The durable store is the session
 * transcript; this map only covers what the not-yet-persisted current
 * turn did, so a save call in the same turn can answer "that card is
 * still unanswered" and the review can cap its rounds.
 *
 * The state hangs off `turn.state` under `'proposals'` and is created
 * lazily by {@link proposalTurnState}, so a turn that never proposes
 * pays nothing.
 */
import type { ProposalOutput } from '../../../shared/authorWire';
import type { AuthorTurn } from '../turnRunner';

/** What a proposal is about: a new agent, or the agent `agentId` an update patches. */
export type ProposalIdentity = { kind: 'create' } | { kind: 'update'; agentId: string };

/**
 * The key `ProposalTurnState` maps/sets are indexed by: `'create'` for a
 * new-agent card, `'update:<agentId>'` for an update card. One open card
 * per identity per turn - proposing again replaces the entry.
 */
export function identityKey(identity: ProposalIdentity): string {
  return identity.kind === 'create' ? 'create' : `update:${identity.agentId}`;
}

/** The proposal bookkeeping one turn accumulates. */
export interface ProposalTurnState {
  /** The newest card proposed THIS turn, by identity key. */
  proposed: Map<string, ProposalOutput>;
  /** Identity keys `discardPendingChanges` cleared this turn (AA11). */
  discarded: Set<string>;
  /** Identity keys saved this turn (AA10b). */
  saved: Set<string>;
  /** Review rounds used per identity key this turn (AA12 caps at 3). */
  reviewRounds: Map<string, number>;
}

/** The `turn.state` key the {@link ProposalTurnState} lives under. */
const PROPOSALS_KEY = 'proposals';

/**
 * The turn's {@link ProposalTurnState}, created on first use and kept in
 * `turn.state['proposals']` - so every tool of the same turn (propose,
 * save, discard, review) shares one record.
 */
export function proposalTurnState(turn: AuthorTurn): ProposalTurnState {
  let state = turn.state.get(PROPOSALS_KEY) as ProposalTurnState | undefined;
  if (state === undefined) {
    state = { proposed: new Map(), discarded: new Set(), saved: new Set(), reviewRounds: new Map() };
    turn.state.set(PROPOSALS_KEY, state);
  }
  return state;
}
