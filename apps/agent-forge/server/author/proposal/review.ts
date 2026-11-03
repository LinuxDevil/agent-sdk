/**
 * The pluggable draft review the propose tools run before showing a card
 * (PLAN §8.4). This module holds only the contract: `AuthorToolDeps.reviewDraft`
 * is injected so AA12 can plug the real review-model pass in behind the
 * same call, and `passReview` - the default `createApp` wires until then -
 * always lets the draft through.
 *
 * A rejected verdict is a returned failure (`pass: false` carries the
 * `AuthorToolFailure` the tool hands back to the model), never a throw -
 * the review bouncing a draft is data, not an error.
 */
import type { AgentSpecV2 } from 'lousho';
import type { AuthorToolFailure, Requirement, SpecChange } from '../../../shared/authorWire';
import type { AuthorTurn } from '../turnRunner';
import type { ProposalIdentity } from './turnState';

/** Everything a review needs to judge the draft a propose call built. */
export interface ReviewInput {
  /** The running turn (state access for AA12's per-identity round cap). */
  turn: AuthorTurn;
  /** What the proposal is about. */
  identity: ProposalIdentity;
  /** Which propose tool is asking, for failure copy. */
  toolName: 'proposeAgent' | 'proposeAgentUpdate';
  /** The complete spec a save would write. */
  spec: AgentSpecV2;
  /** The update diff (`[]` for creates). */
  changes: SpecChange[];
  /** The spec's readiness rows, already computed. */
  requirements: Requirement[];
}

/** The review's answer: let the card through, or return this failure to the model. */
export type ReviewVerdict = { pass: true } | { pass: false; failure: AuthorToolFailure };

/** The review as a dependency: one verdict per input, never throws. */
export type ReviewDraft = (input: ReviewInput) => Promise<ReviewVerdict>;

/**
 * The review every turn gets until AA12 lands the real one: always
 * `{ pass: true }`. `createApp` wires it as `AuthorToolDeps.reviewDraft`'s
 * default so `proposeAgent` already runs the full pipeline.
 */
export const passReview: ReviewDraft = async () => ({ pass: true });
