/**
 * Pending-card folding (PLAN §8.3 "Edits fold earlier unapplied proposals
 * for the same agent into the new one", research §5.4): `pendingUpdateCard`
 * finds the newest still-open update card for an agent - this turn's own
 * proposal record first, then the stored transcript's open card - and
 * `changedTopLevelKeys` reports which spec fields that card moved, for the
 * `carriedFields` a folded card reports.
 *
 * "Open" is the AA10a gate's definition: the newest ok propose part that no
 * later save or discard closed. A card whose `baseSpecHash` no longer
 * matches the saved spec (a canvas edit landed after it was shown) is
 * returned here but ignored by the caller - folding is keyed on the spec
 * the card was built against, not on the card alone.
 */
import type { AgentSpecV2 } from '@linuxdevil/lousho';
import type { ProposalOutput } from '../../../shared/authorWire';
import { SPEC_FIELD_ORDER } from '../../../shared/specFields';
import { stableStringify } from '../../../shared/stableJson';
import type { AuthorTurn } from '../turnRunner';
import { transcriptProposalStatus } from './gate';
import { identityKey, proposalTurnState } from './turnState';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The card `proposeAgentUpdate` folds: the one proposed earlier THIS turn
 * (`proposalTurnState`, which the stored transcript cannot know yet), else
 * the stored transcript's open card for `agentId`. `null` when the turn
 * already discarded or saved the identity, or when no card stays open -
 * an unsaved card is the only thing a new update may inherit.
 */
export function pendingUpdateCard(turn: AuthorTurn, agentId: string): ProposalOutput | null {
  const identity = { kind: 'update', agentId } as const;
  const key = identityKey(identity);
  const state = proposalTurnState(turn);
  if (state.discarded.has(key) || state.saved.has(key)) return null;
  const proposed = state.proposed.get(key);
  if (proposed !== undefined) return proposed;
  const status = transcriptProposalStatus(turn.storedTranscript, identity);
  if (status.state !== 'open') return null;
  for (const message of turn.storedTranscript) {
    if (message.role !== 'assistant') continue;
    for (const part of message.parts) {
      if (
        part.type === 'tool' &&
        part.state === 'done' &&
        part.toolCallId === status.latestProposalId &&
        isRecord(part.output) &&
        part.output.ok === true
      ) {
        return part.output as unknown as ProposalOutput;
      }
    }
  }
  return null;
}

/**
 * The spec fields whose canonical JSON differs between `a` and `b`, in
 * `SPEC_FIELD_ORDER` - the "what did the earlier card change" list a fold
 * turns into `carriedFields`. The compare is key-sorted (`stableStringify`)
 * so a sub-object whose keys were merely reordered does not read as a
 * change. `labels` is skipped: it is a meta field, not a spec key.
 */
export function changedTopLevelKeys(a: AgentSpecV2, b: AgentSpecV2): string[] {
  const aRecord = a as unknown as Record<string, unknown>;
  const bRecord = b as unknown as Record<string, unknown>;
  const changed: string[] = [];
  for (const field of SPEC_FIELD_ORDER) {
    if (field === 'labels') continue;
    if (stableStringify(aRecord[field]) !== stableStringify(bRecord[field])) changed.push(field);
  }
  return changed;
}
