/**
 * The Author's save tools (PLAN §8.2, AA10b): `saveAgent` writes the
 * newest create card, `saveAgentUpdate` the newest update card - both
 * exactly as shown, and only after the user confirmed in a later
 * message. They share `saveFromCard`: the AA10a blocking gate, the
 * stored-card resolution, then the one write path
 * (`proposal/save.ts` `writeProposal`) over the session's workspace.
 *
 * The spec written always comes from the STORED card's output - the
 * model's `proposalId` argument only picks which card; a successful save
 * marks the identity in `proposalTurnState().saved` so a second save in
 * the same turn refuses `ALREADY_SAVED`.
 */
import { defineTool } from '@linuxdevil/lousho';
import { z } from 'zod';
import type { AuthorToolFailure } from '../../../shared/authorWire';
import { resolveStoredProposal, saveBlockingError } from '../proposal/gate';
import { agentGoneFailure } from '../proposal/failures';
import { requestTextForProposal } from '../requestText';
import { writeProposal, type SaveResult } from '../proposal/save';
import { identityKey, proposalTurnState, type ProposalIdentity } from '../proposal/turnState';
import type { AuthorTurn } from '../turnRunner';
import type { AuthorToolDeps, AuthorToolFactory } from './index';

/** The id an `AGENT_GONE` refusal names when the workspace is gone: the update's agent, else the card's name. */
function goneLabel(identity: ProposalIdentity, specName: string): string {
  return identity.kind === 'update' ? identity.agentId : specName;
}

/**
 * The shared execute body both save tools run: gate the save, resolve the
 * stored card, resolve the session's workspace (`AGENT_GONE` when it no
 * longer resolves - PLAN §19.3), then write through `writeProposal`.
 */
async function saveFromCard(
  turn: AuthorTurn,
  deps: AuthorToolDeps,
  identity: ProposalIdentity,
  proposalId: string
): Promise<SaveResult | AuthorToolFailure> {
  const blocked = saveBlockingError(turn, identity);
  if (blocked !== null) return blocked;
  const resolved = resolveStoredProposal(turn.storedTranscript, identity, proposalId);
  if (!resolved.ok) return resolved;
  const workspace = await deps.workspace().catch(() => undefined);
  if (workspace === undefined) return agentGoneFailure(goneLabel(identity, resolved.output.spec.name));
  const result = await writeProposal(identity, resolved.output, {
    sessionId: turn.sessionId,
    requestText: requestTextForProposal(turn.storedTranscript, proposalId),
    agents: workspace.repo,
    versions: workspace.versions,
    sessions: deps.sessions,
    bus: workspace.events,
  });
  if (result.ok) proposalTurnState(turn).saved.add(identityKey(identity));
  return result;
}

/** AA10b's save tool for new agents; updates are `saveAgentUpdate`. */
export const saveAgentTool: AuthorToolFactory = (turn, deps) =>
  defineTool({
    name: 'saveAgent',
    description:
      'Save the newest proposal card for a NEW agent, exactly as shown. Only call it after the user confirmed that card in a later message. The agent is saved disabled.',
    input: z.object({
      proposalId: z
        .string()
        .min(1)
        .max(200)
        .describe('The proposalId of the card the user confirmed, copied exactly from the proposeAgent result.'),
    }),
    execute: ({ proposalId }) => saveFromCard(turn, deps, { kind: 'create' }, proposalId),
  });

/** AA10b's save tool for existing agents; creates are `saveAgent`. */
export const saveAgentUpdateTool: AuthorToolFactory = (turn, deps) =>
  defineTool({
    name: 'saveAgentUpdate',
    description:
      'Save the newest proposal card for an EXISTING agent, exactly as shown. Only call it after the user confirmed that card in a later message.',
    input: z.object({
      agentId: z.string().min(1).max(128).describe('Id of the agent the card changes.'),
      proposalId: z
        .string()
        .min(1)
        .max(200)
        .describe('The proposalId of the update card the user confirmed, copied exactly from the proposeAgentUpdate result.'),
    }),
    execute: ({ agentId, proposalId }) => saveFromCard(turn, deps, { kind: 'update', agentId }, proposalId),
  });
