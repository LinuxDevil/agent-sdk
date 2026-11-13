/**
 * The Author's `proposeAgent` tool (PLAN §8.2, AA08): shows the user a
 * proposal card for a NEW agent and writes nothing. `proposalId` is the
 * call's own `toolCallId` - the transcript is the proposal store, so the
 * card the panel renders is the tool result itself.
 *
 * The pipeline (research §4.1): `draftToSpec` validates the draft against
 * `agentSpecV2Schema` (and appends the chat-trigger backstop), then the
 * catalog checks refuse ids Studio does not have (one failure listing
 * every problem), then the requirements dep computes the card's readiness
 * rows (advisory; `[]` on error), then the injected review gets its say
 * (`passReview` until AA12). Only then is the output recorded under the
 * 'create' identity in {@link proposalTurnState} and returned - a failed
 * step leaves `proposed` untouched.
 */
import { defineTool } from '@linuxdevil/lousho';
import { z } from 'zod';
import type { ProposalOutput } from '../../../shared/authorWire';
import { authorDraftSchema } from '../draft/schema';
import { draftInvalidFailure, draftToSpec } from '../draft/toSpec';
import { checkCatalogs, loadCatalogFacts } from '../proposal/catalogChecks';
import { identityKey, proposalTurnState } from '../proposal/turnState';
import { guardedToolCall } from './failure';
import type { AuthorToolFactory } from './index';

/** AA08's propose tool for new agents; updates are `proposeAgentUpdate` (AA09). */
export const proposeAgentTool: AuthorToolFactory = (turn, deps) =>
  defineTool({
    name: 'proposeAgent',
    description:
      'Show the user a proposal card for a NEW agent. Nothing is saved. After calling it, end your turn and wait for the user to confirm or press Apply.',
    input: z.object({ draft: authorDraftSchema.describe('The complete new agent. Fields you leave out stay unset.') }),
    execute: ({ draft }, ctx) =>
      guardedToolCall('proposeAgent', async () => {
        const built = draftToSpec(draft);
        if (!built.ok) return draftInvalidFailure('proposeAgent', built.issues);
        const catalogFailure = checkCatalogs(built.spec, await loadCatalogFacts(turn, deps), 'proposeAgent');
        if (catalogFailure !== null) return catalogFailure;
        // Requirements are advisory: a dep failure means an empty list, never a failed call.
        const requirements = await deps.requirements(built.spec).catch(() => []);
        const verdict = await deps.reviewDraft({
          turn,
          identity: { kind: 'create' },
          toolName: 'proposeAgent',
          spec: built.spec,
          changes: [],
          requirements,
        });
        if (!verdict.pass) return verdict.failure;
        const output: ProposalOutput = {
          ok: true,
          proposalId: ctx.toolCallId,
          kind: 'create',
          spec: built.spec,
          changes: [],
          requirements,
          carriedOver: false,
          carriedFields: [],
          baseSpecHash: null,
          enabled: false,
        };
        proposalTurnState(turn).proposed.set(identityKey({ kind: 'create' }), output);
        return output;
      }),
  });
