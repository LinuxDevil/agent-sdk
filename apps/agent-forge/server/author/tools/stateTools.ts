/**
 * The Author's two state tools (PLAN §8.2, AA11).
 *
 * `discardPendingChanges` retires unsaved proposal cards without touching
 * anything saved: it drops this turn's `proposed` entry and marks the
 * identity in `discarded`, and its ok part in the stored transcript makes
 * the AA10a gate scan report `none` for that identity - so a later save
 * refuses NO_PROPOSAL and a later propose never folds the dropped card.
 * Nothing gated here needs a write: the refusal cases are "the update's
 * agent isn't on disk" (AGENT_NOT_FOUND) and nothing else.
 *
 * `setAgentEnabled` flips `meta.enabled` directly - no card, no save
 * gate; the prompt confines it to an explicit user request in the same
 * turn (research §4.1, gotcha: code never parses the user's wording).
 * The write itself lives in {@link setAgentEnabledFor}, shared with
 * `POST /assistant/sessions/:id/enable` (the SuccessCard's "Enable agent"
 * button) so the button and the model switch an agent identically.
 */
import { defineTool } from '@linuxdevil/lousho';
import { z } from 'zod';
import type { AgentSpecV2 } from '@linuxdevil/lousho';
import type {
  AuthorToolFailure,
  Requirement,
  SetEnabledOutput,
} from '../../../shared/authorWire';
import type { StudioEventBus } from '../../events/eventBus';
import type { AgentRepo } from '../../storage/agentRepo';
import { withAgentLock } from '../../storage/atomic';
import { identityKey, proposalTurnState, type ProposalIdentity } from '../proposal/turnState';
import { guardedToolCall, toolFailure } from './failure';
import type { AuthorToolFactory } from './index';

/** `AGENT_NOT_FOUND`, same copy as getCurrentSpec (AA06). */
function agentNotFoundFailure(agentId: string): AuthorToolFailure {
  return toolFailure(
    'AGENT_NOT_FOUND',
    `No agent with id "${agentId}".`,
    "That agent doesn't exist.",
    'Call listAgents and copy an id from it.'
  );
}

/**
 * What {@link setAgentEnabledFor} needs: the workspace's agent repo (the
 * merged equivalent of the ticket's `agents.get`/`patchMeta` is
 * `readSpec`/`readMeta`/`writeMeta` under `withAgentLock`, exactly what
 * `PATCH /agents/:id/meta` runs), the readiness computation the
 * `missingRequirements` count comes from, and the workspace event bus for
 * the `agent.changed` fan-out.
 */
export interface SetEnabledDeps {
  agents: AgentRepo;
  /** The spec's readiness rows (AA13's computeRequirements); a throwing dep degrades to `[]`. */
  requirements: (spec: AgentSpecV2) => Promise<Requirement[]>;
  bus?: StudioEventBus;
}

/**
 * The enable/disable write both the tool and the enable route perform:
 * `enabled` already matching is an `unchanged` no-op (no write, no
 * event); otherwise meta is patched the way `PATCH /agents/:id/meta`
 * does it - enabling clears the disable fields and the failure streak,
 * disabling stamps `disabledAt` and `disabledReason: 'manual'` - inside
 * the agent lock, then `agent.changed` (`reason: 'meta'`) publishes so
 * open tabs refresh. `missingRequirements` counts the spec's `missing`
 * readiness rows either way: the switch lands even when the agent is not
 * runnable yet, and the number exists for the reply to say so.
 */
export async function setAgentEnabledFor(
  agentId: string,
  enabled: boolean,
  deps: SetEnabledDeps
): Promise<SetEnabledOutput | AuthorToolFailure> {
  const spec = await deps.agents.readSpec(agentId);
  if (spec === undefined) return agentNotFoundFailure(agentId);
  const rows = await deps.requirements(spec).catch(() => []);
  const missingRequirements = rows.filter((row) => row.status === 'missing').length;
  const meta = await deps.agents.readMeta(agentId);
  if (meta.enabled === enabled) {
    return { ok: true, agentId, enabled, status: 'unchanged', missingRequirements };
  }
  const now = new Date().toISOString();
  await withAgentLock(agentId, async () => {
    const current = await deps.agents.readMeta(agentId);
    await deps.agents.writeMeta(agentId, {
      ...current,
      updatedAt: now,
      ...(enabled
        ? { enabled: true, disabledAt: null, disabledReason: null, failureStreak: 0 }
        : { enabled: false, disabledAt: now, disabledReason: 'manual' as const }),
    });
  });
  deps.bus?.publish({ type: 'agent.changed', agentId, reason: 'meta' });
  return { ok: true, agentId, enabled, status: 'updated', missingRequirements };
}

/** AA11's discard tool: drops unsaved cards for one identity, never the saved agent. */
export const discardPendingChangesTool: AuthorToolFactory = (turn, deps) =>
  defineTool({
    name: 'discardPendingChanges',
    description:
      'Drop the unsaved proposal cards for one agent, or for the new-agent card when agentId is omitted. Nothing saved is changed. Call it before telling the user their unsaved changes are gone.',
    input: z.object({
      agentId: z
        .string()
        .min(1)
        .max(128)
        .optional()
        .describe('Agent whose unsaved update cards to drop. Omit to drop the unsaved new-agent card.'),
    }),
    execute: ({ agentId }) =>
      guardedToolCall('discardPendingChanges', async () => {
        const identity: ProposalIdentity =
          agentId === undefined ? { kind: 'create' } : { kind: 'update', agentId };
        if (identity.kind === 'update') {
          const { repo } = await deps.workspace();
          if ((await repo.readSpec(identity.agentId)) === undefined) {
            return agentNotFoundFailure(identity.agentId);
          }
        }
        const state = proposalTurnState(turn);
        const key = identityKey(identity);
        state.proposed.delete(key);
        state.discarded.add(key);
        const message =
          identity.kind === 'create'
            ? 'The unsaved new-agent card was discarded. Nothing was saved.'
            : 'Unsaved changes for this agent were discarded. Nothing was saved. The next proposal starts from the saved agent.';
        return identity.kind === 'create'
          ? { ok: true, message }
          : { ok: true, agentId: identity.agentId, message };
      }),
  });

/** AA11's enable/disable tool; the prompt gates it on an explicit user request. */
export const setAgentEnabledTool: AuthorToolFactory = (_turn, deps) =>
  defineTool({
    name: 'setAgentEnabled',
    description:
      "Turn an agent on or off. Only when the user asked for it in this turn. A disabled agent's triggers never fire.",
    input: z.object({
      agentId: z.string().min(1).max(128).describe('Id of a saved agent.'),
      enabled: z.boolean().describe('true to turn the agent on, false to turn it off.'),
    }),
    execute: ({ agentId, enabled }) =>
      guardedToolCall('setAgentEnabled', async () => {
        const workspace = await deps.workspace();
        return setAgentEnabledFor(agentId, enabled, {
          agents: workspace.repo,
          bus: workspace.events,
          requirements: deps.requirements,
        });
      }),
  });
