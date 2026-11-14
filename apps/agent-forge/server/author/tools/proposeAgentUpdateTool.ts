/**
 * The Author's `proposeAgentUpdate` tool (PLAN §8.2, AA09): shows the user
 * a proposal card that changes an EXISTING agent and writes nothing. The
 * card's `spec` is the saved spec plus any earlier unsaved card for the
 * same agent plus this call's patch - the fold (research §5.4) - and the
 * card's `changes` are a server-computed `diffSpecs` against the saved
 * spec, so the card always shows the whole change, not just this call's.
 *
 * The pipeline (research §4.1 `executeUpdatePreview`): the agent must
 * exist, the patch must change something, `patch.instructions` and
 * `instructionsEdits` are mutually exclusive, an earlier open card folds
 * in only while its `baseSpecHash` still matches the saved spec (a canvas
 * edit breaks the chain), anchored edits resolve against the folded base
 * and fall back to the saved instructions, then the merged patch runs the
 * same build / catalog / requirements / review gauntlet as `proposeAgent`.
 */
import { defineTool } from '@linuxdevil/lousho';
import { z } from 'zod';
import type { AgentSpecV2 } from '@linuxdevil/lousho';
import type { AuthorToolFailure, ProposalOutput } from '../../../shared/authorWire';
import { diffSpecs } from '../../diff/specChange';
import { specHash } from '../../storage/specHash';
import { authorPatchSchema, type AuthorPatch } from '../draft/schema';
import { applyAuthorPatch, draftInvalidFailure } from '../draft/toSpec';
import { checkCatalogs, loadCatalogFacts } from '../proposal/catalogChecks';
import { changedTopLevelKeys, pendingUpdateCard } from '../proposal/fold';
import { applyInstructionsEdits, type EditsResult, type InstructionsEdit } from '../proposal/instructionsEdits';
import { identityKey, proposalTurnState } from '../proposal/turnState';
import type { AuthorTurn } from '../turnRunner';
import { guardedToolCall, toolFailure } from './failure';
import type { AuthorToolDeps, AuthorToolFactory } from './index';

/** The person-facing sentence every anchor failure shares (the model-facing copy differs per code). */
const ANCHOR_USER_MESSAGE = "The Author's edit didn't match the current instructions. It is retrying.";

/** `AGENT_NOT_FOUND`, same copy as getCurrentSpec (AA06). */
function agentNotFoundFailure(agentId: string): AuthorToolFailure {
  return toolFailure(
    'AGENT_NOT_FOUND',
    `No agent with id "${agentId}".`,
    "That agent doesn't exist.",
    'Call listAgents and copy an id from it.'
  );
}

/** `EMPTY_PATCH`: neither the patch nor `instructionsEdits` carries a change. */
function emptyPatchFailure(): AuthorToolFailure {
  return toolFailure(
    'EMPTY_PATCH',
    'The patch changes nothing.',
    'The Author sent an empty change. It is retrying.',
    'Include at least one field to change, or instructionsEdits.'
  );
}

/** `EDITS_AND_INSTRUCTIONS`: a full instructions rewrite and anchored edits in one call. */
function editsAndInstructionsFailure(): AuthorToolFailure {
  return toolFailure(
    'EDITS_AND_INSTRUCTIONS',
    'Send either patch.instructions or instructionsEdits, not both.',
    'The Author sent conflicting instruction changes. It is retrying.',
    'Use instructionsEdits for a partial change and patch.instructions only for a full rewrite.'
  );
}

/** `INSTRUCTIONS_IN_FILE`: the spec's instructions are a `{ file }` reference anchored edits cannot rewrite. */
function instructionsInFileFailure(instructions: AgentSpecV2['instructions']): AuthorToolFailure {
  const file =
    typeof instructions === 'object' && instructions !== null && 'file' in instructions
      ? String(instructions.file)
      : 'unknown';
  return toolFailure(
    'INSTRUCTIONS_IN_FILE',
    `This agent's instructions live in the file "${file}", so they cannot be edited here.`,
    "This agent's instructions are in a file, so the Author can't edit them here.",
    'Tell the user to edit that file. Send a full instructions string only if they ask to replace the file reference.'
  );
}

/**
 * The `ANCHOR_*` failure for a rejected edit set. `currentInstructions` is
 * exactly the text the edits were tried against (the folded base's), so the
 * model can copy a verbatim anchor from it; `retryWith: 'instructions'`
 * flags that a full rewrite is also a way out.
 */
function anchorFailure(result: Extract<EditsResult, { ok: false }>, currentInstructions: string): AuthorToolFailure {
  const extra = { currentInstructions, retryWith: 'instructions' };
  switch (result.code) {
    case 'ANCHOR_NOT_FOUND':
      return toolFailure(
        'ANCHOR_NOT_FOUND',
        `instructionsEdits[${result.index}].oldText was not found in the current instructions.`,
        ANCHOR_USER_MESSAGE,
        'Copy oldText verbatim from currentInstructions, or send the full instructions instead.',
        extra
      );
    case 'ANCHOR_AMBIGUOUS':
      return toolFailure(
        'ANCHOR_AMBIGUOUS',
        `instructionsEdits[${result.index}].oldText occurs ${result.occurrences ?? 0} times; it must occur exactly once.`,
        ANCHOR_USER_MESSAGE,
        'Include more surrounding text so it matches exactly once.',
        extra
      );
    default:
      return toolFailure(
        'ANCHOR_OVERLAP',
        `instructionsEdits[${result.index}] and instructionsEdits[${result.otherIndex ?? '?'}] overlap.`,
        ANCHOR_USER_MESSAGE,
        'Merge them into one edit.',
        extra
      );
  }
}

/** The base the new patch applies to and the field names an earlier open card already changed. */
interface BaseResolution {
  /** `pending.spec` while the earlier card still patches today's saved spec, else `saved`. */
  base: AgentSpecV2;
  /** Fields the folded card contributed (empty without a usable pending card). */
  carried: string[];
  /** Whether `base` is the pending card's spec. */
  usable: boolean;
}

/**
 * The fold step (PLAN §8.3): the newest still-open update card for this
 * agent becomes the patch's base only while the saved spec is still the
 * spec that card was built on (`baseSpecHash`). A canvas edit after the
 * card was shown breaks the chain - the pending card is ignored, not
 * merged, so it can never resurrect a spec the user overwrote.
 */
function resolveBase(turn: AuthorTurn, agentId: string, saved: AgentSpecV2, savedHash: string): BaseResolution {
  const pending = pendingUpdateCard(turn, agentId);
  const usable = pending !== null && pending.baseSpecHash === savedHash;
  return {
    base: usable && pending !== null ? pending.spec : saved,
    carried: usable && pending !== null ? changedTopLevelKeys(saved, pending.spec) : [],
    usable,
  };
}

/** What {@link applyEdits} yields: the patch to build (possibly with resolved `instructions`), or the failure. */
type EditsResolution = { ok: true; effectivePatch: AuthorPatch; carried: string[] } | AuthorToolFailure;

/**
 * Resolves `instructionsEdits` against the base instructions: anchors must
 * land on the folded text, and when they do not the SAVED instructions get
 * one retry (the model may have copied its anchor from getCurrentSpec
 * instead of from the folded card) - a successful retry drops
 * `instructions` from `carried`, since the result no longer inherits the
 * pending card's prompt. The resolution becomes `patch.instructions`, so
 * the rest of the pipeline sees one merged patch.
 */
function applyEdits(
  patch: AuthorPatch,
  edits: readonly InstructionsEdit[] | undefined,
  resolved: BaseResolution,
  saved: AgentSpecV2
): EditsResolution {
  if (edits === undefined || edits.length === 0) {
    return { ok: true, effectivePatch: patch, carried: resolved.carried };
  }
  if (typeof resolved.base.instructions !== 'string') {
    return instructionsInFileFailure(resolved.base.instructions);
  }
  let result = applyInstructionsEdits(resolved.base.instructions, edits);
  let carried = resolved.carried;
  if (!result.ok && resolved.usable && typeof saved.instructions === 'string') {
    const retry = applyInstructionsEdits(saved.instructions, edits);
    if (retry.ok) {
      result = retry;
      carried = carried.filter((key) => key !== 'instructions');
    }
  }
  if (!result.ok) return anchorFailure(result, resolved.base.instructions);
  return { ok: true, effectivePatch: { ...patch, instructions: result.text }, carried };
}

/** The fields `proposeAgentUpdate` still needs once the agent is found and the edits resolved. */
interface CardContext {
  turn: AuthorTurn;
  deps: AuthorToolDeps;
  agentId: string;
  toolCallId: string;
  saved: AgentSpecV2;
  savedHash: string;
  enabled: boolean;
  base: AgentSpecV2;
  effectivePatch: AuthorPatch;
  carried: string[];
}

/**
 * Builds and records the card: merged patch -> spec validation
 * (`draftInvalidFailure` on schema problems) -> catalog checks -> the diff
 * against the saved spec -> `carriedFields` (what the fold contributed
 * that this call did not itself touch) -> advisory requirements -> the
 * pluggable review. Only a passing run lands in `proposalTurnState` and
 * reaches the model as the card.
 */
async function buildCard(ctx: CardContext): Promise<ProposalOutput | AuthorToolFailure> {
  const built = applyAuthorPatch(ctx.base, ctx.effectivePatch);
  if (!built.ok) return draftInvalidFailure('proposeAgentUpdate', built.issues);
  const catalogFailure = checkCatalogs(built.spec, await loadCatalogFacts(ctx.turn, ctx.deps), 'proposeAgentUpdate');
  if (catalogFailure !== null) return catalogFailure;
  const changes = diffSpecs({ spec: ctx.saved, labels: [] }, { spec: built.spec, labels: [] });
  const patchKeys = new Set(
    Object.keys(ctx.effectivePatch).filter(
      (key) => (ctx.effectivePatch as Record<string, unknown>)[key] !== undefined
    )
  );
  const carriedFields = ctx.carried.filter((key) => !patchKeys.has(key));
  // Requirements are advisory: a dep failure means an empty list, never a failed call.
  const requirements = await ctx.deps.requirements(built.spec).catch(() => []);
  const verdict = await ctx.deps.reviewDraft({
    turn: ctx.turn,
    identity: { kind: 'update', agentId: ctx.agentId },
    toolName: 'proposeAgentUpdate',
    spec: built.spec,
    changes,
    requirements,
  });
  if (!verdict.pass) return verdict.failure;
  const output: ProposalOutput = {
    ok: true,
    proposalId: ctx.toolCallId,
    kind: 'update',
    agentId: ctx.agentId,
    spec: built.spec,
    changes,
    requirements,
    carriedOver: carriedFields.length > 0,
    carriedFields,
    baseSpecHash: ctx.savedHash,
    enabled: ctx.enabled,
  };
  proposalTurnState(ctx.turn).proposed.set(identityKey({ kind: 'update', agentId: ctx.agentId }), output);
  return output;
}

/** The earliest refusal that applies, in pipeline order, or `null`. */
function inputFailure(
  patch: AuthorPatch,
  edits: readonly InstructionsEdit[] | undefined
): AuthorToolFailure | null {
  if (Object.keys(patch).length === 0 && (edits === undefined || edits.length === 0)) {
    return emptyPatchFailure();
  }
  if (patch.instructions !== undefined && edits !== undefined && edits.length > 0) {
    return editsAndInstructionsFailure();
  }
  return null;
}

/** AA09's update tool for existing agents; creates are `proposeAgent` (AA08). */
export const proposeAgentUpdateTool: AuthorToolFactory = (turn, deps) =>
  defineTool({
    name: 'proposeAgentUpdate',
    description:
      'Show the user a proposal card that changes an EXISTING agent. Nothing is saved. An earlier unsaved card for the same agent is folded in. After calling it, end your turn and wait for the user to confirm.',
    input: z.object({
      agentId: z.string().min(1).max(128).describe('Id of the agent to change, from listAgents or the turn context.'),
      patch: authorPatchSchema.describe(
        'Only the fields that change. Omitted = keep, a list replaces the whole list, [] clears, null resets to the default.'
      ),
      instructionsEdits: z
        .array(
          z
            .object({
              oldText: z
                .string()
                .min(1)
                .max(5000)
                .describe('Text copied verbatim from the current instructions. Must occur exactly once.'),
              newText: z.string().max(20000).describe('The replacement. An empty string deletes oldText.'),
            })
            .describe('One anchored edit: replace the one occurrence of oldText with newText.')
        )
        .max(20)
        .optional()
        .describe('Anchored edits to the instructions. Never combine with patch.instructions.'),
    }),
    execute: ({ agentId, patch, instructionsEdits }, ctx) =>
      guardedToolCall('proposeAgentUpdate', async () => {
        const { repo } = await deps.workspace();
        const saved = await repo.readSpec(agentId);
        if (saved === undefined) return agentNotFoundFailure(agentId);
        const refused = inputFailure(patch, instructionsEdits);
        if (refused !== null) return refused;
        const meta = await repo.readMeta(agentId);
        const savedHash = specHash(saved);
        const resolved = resolveBase(turn, agentId, saved, savedHash);
        const edits = applyEdits(patch, instructionsEdits, resolved, saved);
        if (!edits.ok) return edits;
        return buildCard({
          turn,
          deps,
          agentId,
          toolCallId: ctx.toolCallId,
          saved,
          savedHash,
          enabled: meta.enabled,
          base: resolved.base,
          effectivePatch: edits.effectivePatch,
          carried: edits.carried,
        });
      }),
  });
