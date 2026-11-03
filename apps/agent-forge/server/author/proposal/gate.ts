/**
 * The save gate (PLAN §8.3 "Save refuses when ... (enforced in code)",
 * research §5.2): pure functions that decide, from the STORED transcript
 * (which ends at the previous turn) and this turn's `ProposalTurnState`,
 * whether a save may run and which stored card it writes. Nothing here
 * does I/O and nothing writes: a refusal is returned as an
 * `AuthorToolFailure`, and an allowed save resolves to the stored card's
 * input/output - AA10b's save tools and the Apply route perform the write
 * behind these checks, so a proposal can never reach disk unconfirmed.
 *
 * A "card" is an ok tool part: `type: 'tool'`, `state: 'done'`, output a
 * record with `ok === true`. A failed (`ok: false`) propose result - a
 * bounced review included - is not a card. Update gates are per agent: a
 * card for agent A never authorises a write to B.
 */
import type {
  AuthorAssistantMessage,
  AuthorMessage,
  AuthorToolFailure,
  AuthorToolPart,
  ProposalOutput,
} from '../../../shared/authorWire';
import type { TurnContextInput } from '../turnContext';
import type { AuthorTurn } from '../turnRunner';
import { identityKey, proposalTurnState, type ProposalIdentity } from './turnState';
import {
  PROPOSE_TOOL,
  alreadySavedFailure,
  ambiguousProposalFailure,
  noProposalFailure,
  staleProposalFailure,
  unansweredFailure,
  unknownProposalFailure,
  wrongAgentFailure,
} from './failures';

/**
 * The propose tool that shows a card for each proposal kind - declared in
 * `failures.ts` (its refusal copy names it) and re-exported here so the
 * whole save-gate contract imports from this one module.
 */
// fallow-ignore-next-line unused-export -- part of the AA10a save-gate contract; AA10b's save tools read it
export { PROPOSE_TOOL } from './failures';

/** The save tool that writes a card for each proposal kind (AA10b registers them). */
// fallow-ignore-next-line unused-export -- part of the AA10a save-gate contract; AA10b's save tools read it
export const SAVE_TOOL = { create: 'saveAgent', update: 'saveAgentUpdate' } as const;

/** Where an identity's newest card stands in the stored transcript. */
export type ProposalState = 'none' | 'open' | 'saved';

/** The transcript scan's answer: the state plus the newest card's id (kept even after a discard). */
export interface ProposalStatus {
  state: ProposalState;
  latestProposalId: string | null;
}

/** `resolveStoredProposal`'s answer: the stored card's payload to write, or why it refused. */
export type StoredProposalResult =
  | { ok: true; proposalId: string; input: unknown; output: ProposalOutput }
  | AuthorToolFailure;

/** The tool names that carry an `agentId` and therefore belong to one update identity. */
const PER_AGENT_TOOLS: ReadonlySet<string> = new Set([
  PROPOSE_TOOL.update,
  SAVE_TOOL.update,
  'discardPendingChanges',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Whether the part is a card-carrying tool result: done, with an
 * `{ ok: true }` object output. Error-state parts and `ok: false`
 * outputs (a bounced review, a refusal) never count.
 */
function isOkToolPart(
  part: AuthorAssistantMessage['parts'][number]
): part is AuthorToolPart & { output: Record<string, unknown> } {
  return part.type === 'tool' && part.state === 'done' && isRecord(part.output) && part.output.ok === true;
}

/** The `agentId` a tool input carries, when it is a record with a string one. */
function agentIdOf(input: unknown): string | undefined {
  return isRecord(input) && typeof input.agentId === 'string' ? input.agentId : undefined;
}

/**
 * Whether a `discardPendingChanges` input clears `identity`: an input
 * without `agentId` clears the create card (and the update scan filters
 * per agent before this runs), `{ agentId }` clears that agent's card.
 */
function discardMatches(input: unknown, identity: ProposalIdentity): boolean {
  const agentId = agentIdOf(input);
  return identity.kind === 'create' ? agentId === undefined : agentId === identity.agentId;
}

/**
 * Whether an ok part belongs to `identity`'s stream at all: for an update
 * identity, the per-agent tools (propose/save update, discard) only count
 * when their `agentId` is this agent's - a card for A never moves B's gate.
 */
function belongsToIdentity(part: AuthorToolPart, identity: ProposalIdentity): boolean {
  if (identity.kind !== 'update' || !PER_AGENT_TOOLS.has(part.name)) return true;
  return agentIdOf(part.input) === identity.agentId;
}

/**
 * One ok part folded into the scan: the matching propose opens (and becomes
 * the newest card), the matching save while open saves it, a matching
 * discard clears it back to none.
 */
function applyPart(scan: ProposalStatus, part: AuthorToolPart, identity: ProposalIdentity): void {
  if (part.name === PROPOSE_TOOL[identity.kind]) {
    scan.state = 'open';
    scan.latestProposalId = part.toolCallId;
  } else if (part.name === SAVE_TOOL[identity.kind] && scan.state === 'open') {
    scan.state = 'saved';
  } else if (part.name === 'discardPendingChanges' && discardMatches(part.input, identity)) {
    scan.state = 'none';
  }
}

/**
 * An identity's status across the stored transcript, in order. A `uiEvent`
 * user message with `kind: 'save'` is the Apply button's footprint: it
 * saves the card only when it names the newest open one.
 */
export function transcriptProposalStatus(
  messages: readonly AuthorMessage[],
  identity: ProposalIdentity
): ProposalStatus {
  const scan: ProposalStatus = { state: 'none', latestProposalId: null };
  for (const message of messages) {
    if (message.role === 'user') {
      if (
        message.uiEvent?.kind === 'save' &&
        scan.state === 'open' &&
        message.uiEvent.proposalId === scan.latestProposalId
      ) {
        scan.state = 'saved';
      }
      continue;
    }
    for (const part of message.parts) {
      if (isOkToolPart(part) && belongsToIdentity(part, identity)) {
        applyPart(scan, part, identity);
      }
    }
  }
  return scan;
}

/**
 * Why a model save must not run now, or `null` when it may. The this-turn
 * checks come first: a card proposed this turn is `UNANSWERED` (the stored
 * transcript cannot know about it), a discard this turn removes the card,
 * and one confirmation buys exactly one save. Only then does the stored
 * transcript - which ends at the previous turn - get scanned, so any open
 * card found there was genuinely shown to the user.
 */
export function saveBlockingError(turn: AuthorTurn, identity: ProposalIdentity): AuthorToolFailure | null {
  const key = identityKey(identity);
  const state = proposalTurnState(turn);
  if (state.proposed.has(key)) return unansweredFailure(identity.kind);
  if (state.discarded.has(key)) return noProposalFailure(identity.kind);
  if (state.saved.has(key)) return alreadySavedFailure();
  const status = transcriptProposalStatus(turn.storedTranscript, identity);
  if (status.state === 'saved') return alreadySavedFailure();
  if (status.state === 'none') return noProposalFailure(identity.kind);
  return null;
}

/**
 * The stored card `proposalId` refers to, for the save path that writes
 * exactly what the user saw. Refuses when the id names more than one tool
 * call (`AMBIGUOUS_PROPOSAL` - providers may reuse ids), no ok propose part
 * (`UNKNOWN_PROPOSAL`), another agent's card (`WRONG_AGENT`), a superseded
 * card (`STALE_PROPOSAL`, carrying `latestProposalId`), an already-saved
 * one (`ALREADY_SAVED`), or a discarded/never-open one (`NO_PROPOSAL`).
 */
export function resolveStoredProposal(
  messages: readonly AuthorMessage[],
  identity: ProposalIdentity,
  proposalId: string
): StoredProposalResult {
  let matchingCalls = 0;
  let found: (AuthorToolPart & { output: Record<string, unknown> }) | undefined;
  for (const part of toolParts(messages)) {
    if (part.toolCallId !== proposalId) continue;
    matchingCalls += 1;
    if (isOkToolPart(part) && part.name === PROPOSE_TOOL[identity.kind]) found = part;
  }
  if (matchingCalls > 1) return ambiguousProposalFailure(identity.kind, proposalId);
  if (found === undefined) return unknownProposalFailure(identity.kind, proposalId);
  if (identity.kind === 'update' && agentIdOf(found.input) !== identity.agentId) {
    return wrongAgentFailure(proposalId, agentIdOf(found.input) ?? 'unknown', identity.agentId);
  }
  const status = transcriptProposalStatus(messages, identity);
  // `found` being an ok propose part for this identity guarantees a non-null latest.
  if (status.latestProposalId !== proposalId) {
    return staleProposalFailure(proposalId, status.latestProposalId ?? 'none');
  }
  if (status.state === 'saved') return alreadySavedFailure();
  if (status.state !== 'open') return noProposalFailure(identity.kind);
  return { ok: true, proposalId, input: found.input, output: found.output as unknown as ProposalOutput };
}

/** Every tool part of every assistant message, in transcript order. */
function* toolParts(messages: readonly AuthorMessage[]): Generator<AuthorToolPart> {
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const part of message.parts) {
      if (part.type === 'tool') yield part;
    }
  }
}

/**
 * The identity a `proposalId` belongs to - its ok propose part - or `null`
 * when no card carries it. The Apply route (AA10b) needs this to pick which
 * gate a bare `proposalId` is answered by; the update identity's `agentId`
 * comes from the stored input (falling back to the card output).
 */
export function identityOfProposal(
  messages: readonly AuthorMessage[],
  proposalId: string
): ProposalIdentity | null {
  for (const part of toolParts(messages)) {
    if (part.toolCallId !== proposalId || !isOkToolPart(part)) continue;
    if (part.name === PROPOSE_TOOL.create) return { kind: 'create' };
    if (part.name === PROPOSE_TOOL.update) {
      const agentId = agentIdOf(part.input) ?? agentIdOf(part.output);
      return agentId === undefined ? null : { kind: 'update', agentId };
    }
  }
  return null;
}

/** The identity an ok propose part opened a card for, or `undefined` for any other tool. */
function identityOfPart(part: AuthorToolPart): ProposalIdentity | undefined {
  if (part.name === PROPOSE_TOOL.create) return { kind: 'create' };
  if (part.name === PROPOSE_TOOL.update) {
    const agentId = agentIdOf(part.input) ?? agentIdOf(part.output);
    return agentId === undefined ? undefined : { kind: 'update', agentId };
  }
  return undefined;
}

/**
 * The still-open cards for the turn-context block (PLAN §8.1's "open
 * proposal ids"), oldest card first so the list reads "newest last". Every
 * identity whose transcript status is `open` contributes one entry named
 * after its card's `spec.name`; saved or discarded cards drop out because
 * their status is no longer open.
 */
export function openProposalCards(messages: readonly AuthorMessage[]): TurnContextInput['openProposals'] {
  // The latest ok propose part per identity; delete+set re-inserts so the
  // map stays ordered by each card's newest position in the transcript.
  const latest = new Map<string, { identity: ProposalIdentity; part: AuthorToolPart }>();
  for (const part of toolParts(messages)) {
    if (!isOkToolPart(part)) continue;
    const identity = identityOfPart(part);
    if (identity === undefined) continue;
    const key = identityKey(identity);
    latest.delete(key);
    latest.set(key, { identity, part });
  }
  const open: TurnContextInput['openProposals'] = [];
  for (const entry of latest.values()) {
    const status = transcriptProposalStatus(messages, entry.identity);
    if (status.state !== 'open' || status.latestProposalId !== entry.part.toolCallId) continue;
    open.push({
      proposalId: entry.part.toolCallId,
      kind: entry.identity.kind,
      ...(entry.identity.kind === 'update' && { agentId: entry.identity.agentId }),
      name: cardName(entry),
    });
  }
  return open;
}

/** A card's display name: its `spec.name`, else a usable fallback for a malformed stored part. */
function cardName(entry: { identity: ProposalIdentity; part: AuthorToolPart }): string {
  const output = entry.part.output;
  if (isRecord(output) && isRecord(output.spec) && typeof output.spec.name === 'string') {
    return output.spec.name;
  }
  return entry.identity.kind === 'update' ? entry.identity.agentId : entry.part.toolCallId;
}
