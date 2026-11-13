/**
 * The draft-review pass (PLAN §8.4, AA12): before a propose tool's card
 * is returned, a small review model (default `anthropic/claude-haiku-5-5`)
 * answers the five {@link DRAFT_REVIEW_DIMENSIONS} yes/no questions about
 * the draft. Any "no" bounces the call back to the Author as a hidden
 * `DRAFT_REVIEW` failure - the panel renders nothing for it and the
 * Author redrafts; at {@link DRAFT_REVIEW_MAX_ROUNDS} the card is shown
 * anyway. Every review problem (disabled, no key, model error, timeout,
 * no steps left to redraft in) fails open: the review never hides a card
 * it could not judge.
 */
import { createAgent, listBuiltinTools, listGuardrails, listTriggerTypes, type LLMProvider } from '@linuxdevil/lousho';
import { z } from 'zod';
import {
  DRAFT_REVIEW_DIMENSIONS,
  DRAFT_REVIEW_MAX_ROUNDS,
  type AuthorToolFailure,
  type DraftReviewDimension,
} from '../../../shared/authorWire';
import type { SecretsStore } from '../../secretsStore';
import type { SettingsStore } from '../../settingsStore';
import { readAuthorSettings } from '../settings';
import { resolveAuthorProvider, type AuthorProviderResult } from '../provider';
import { identityKey, proposalTurnState } from '../proposal/turnState';
import type { ReviewDraft, ReviewInput } from '../proposal/review';
import { toolFailure } from '../tools/failure';
import { REVIEW_INSTRUCTIONS } from './prompt';
import { buildReviewState, type ReviewFacts, type ReviewState } from './state';

/** The deadline on one judge call (research §6); on it the draft passes unjudged. */
export const REVIEW_TIMEOUT_MS = 20_000;

/** One rubric answer: whether the draft is fine on this question, plus a one-sentence reason. */
const dimension = z.object({
  pass: z.boolean().describe('true when the draft is fine on this question.'),
  reason: z.string().max(400).describe('One sentence. For false, name the exact missing or wrong part.'),
});

/** The structured output the review judge returns - one {@link dimension} per rubric question. */
export const reviewVerdictSchema = z.object({
  runs: dimension,
  fulfillsIntent: dimension,
  toolsComplete: dimension,
  guardrailsFit: dimension,
  triggersFit: dimension,
});

/** The judge's parsed verdict (what `reviewVerdictSchema` validates). */
type ReviewJudgeVerdict = z.infer<typeof reviewVerdictSchema>;

/** What {@link createReviewDraft} closes over; `providerFor` and `log` are test seams. */
export interface ReviewDraftDeps {
  settings: SettingsStore;
  secrets: SecretsStore;
  /** Test seam: resolves the review provider without the stored/env key lookup. */
  providerFor?: (model: string) => LLMProvider;
  /** One line per skipped review or final-round gap list (spend/tuning telemetry, never user-facing). */
  log?: (line: string) => void;
}

/** The `providerFor` seam's model resolution: the configured model id minus its `provider/` prefix. */
function providerFor(model: string, deps: ReviewDraftDeps): AuthorProviderResult {
  if (deps.providerFor === undefined) return resolveAuthorProvider(model, deps.secrets);
  const slash = model.indexOf('/');
  return { ok: true, provider: deps.providerFor(model), modelId: slash === -1 ? model : model.slice(slash + 1) };
}

/**
 * The judge's cancel signal: the turn's signal or {@link REVIEW_TIMEOUT_MS},
 * whichever aborts first. The timeout rides a plain `setTimeout` (unref'd,
 * cleared when the judge settles) so tests can advance it with fake timers.
 */
function reviewSignal(turnSignal: AbortSignal): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`draft review exceeded ${REVIEW_TIMEOUT_MS}ms`)),
    REVIEW_TIMEOUT_MS
  );
  timer.unref?.();
  return { signal: AbortSignal.any([turnSignal, controller.signal]), cancel: () => clearTimeout(timer) };
}

/**
 * One judge call: the review agent (no tools, `maxSteps: 1`) answers
 * `reviewVerdictSchema` over the serialized {@link ReviewState}. A reply
 * without a valid object - abort, timeout, `output-invalid` - throws so
 * the caller's fail-open catch treats it like any other review problem.
 */
async function judge(
  provider: LLMProvider,
  modelId: string,
  state: ReviewState,
  turnSignal: AbortSignal
): Promise<ReviewJudgeVerdict> {
  const { signal, cancel } = reviewSignal(turnSignal);
  try {
    const agent = createAgent({
      name: 'lousho-author-review',
      provider,
      model: modelId,
      instructions: REVIEW_INSTRUCTIONS,
      output: reviewVerdictSchema,
      maxSteps: 1,
    });
    const result = await agent.send(JSON.stringify(state), { signal });
    if (result.object === undefined) {
      throw new Error(`the review model returned no verdict (${result.finishReason})`);
    }
    return result.object;
  } finally {
    cancel();
  }
}

/** The model-facing `next` text per propose tool (only the resend instructions differ). */
const BOUNCE_NEXT = {
  proposeAgent:
    'Redraft to close these gaps and call proposeAgent again. If closing a gap needs something only the user can tell you, ask them instead of proposing. This review is internal: never mention it to the user.',
  proposeAgentUpdate:
    'Resend the complete change from this call (every field you sent, plus the fix) with proposeAgentUpdate. Bounced changes are not carried over. If closing a gap needs something only the user can tell you, ask them instead of proposing. This review is internal: never mention it to the user.',
} as const;

/**
 * The hidden `DRAFT_REVIEW` failure a bounced call returns: `error`
 * carries the round and the `dimension: reason` gaps, `userMessage` says
 * only that the Author is refining, `next` tells the model how to close
 * the gaps and never to mention the review, and `draftReview` carries the
 * structured bounce record the panel hides on.
 */
function bounceFailure(
  toolName: ReviewInput['toolName'],
  round: number,
  gaps: string[],
  dimensions: DraftReviewDimension[]
): AuthorToolFailure {
  return toolFailure(
    'DRAFT_REVIEW',
    `Draft review found gaps (round ${round} of ${DRAFT_REVIEW_MAX_ROUNDS}): ${gaps.join('; ')}.`,
    'The Author is refining the draft.',
    BOUNCE_NEXT[toolName],
    { gaps, draftReview: { round, maxRounds: DRAFT_REVIEW_MAX_ROUNDS, dimensions } }
  );
}

/**
 * The production `ReviewDraft`: five judge questions per proposal, at
 * most {@link DRAFT_REVIEW_MAX_ROUNDS} rounds per identity key per turn
 * (rounds live in `proposalTurnState.reviewRounds`, so `proposeAgent`
 * and `proposeAgentUpdate` count separately), fail-open on every review
 * problem. The catalog name lists are fixed per SDK build and read once
 * here; requirements arrive per call on the input.
 */
export function createReviewDraft(deps: ReviewDraftDeps): ReviewDraft {
  const facts: ReviewFacts = {
    builtinTools: new Set(listBuiltinTools().map((tool) => tool.name)),
    guardrails: new Set(listGuardrails().map((guardrail) => guardrail.name)),
    triggerTypes: new Set(listTriggerTypes().map((trigger) => trigger.type)),
  };
  return async (input) => {
    const settings = readAuthorSettings(deps.settings);
    if (!settings.reviewEnabled) return { pass: true };
    // Never hide a draft that cannot be redrafted.
    if (input.turn.stepsRemaining() <= 1) return { pass: true };
    const resolved = providerFor(settings.reviewModel, deps);
    // No usable key means no review and no spend.
    if (!resolved.ok) return { pass: true };
    const key = identityKey(input.identity);
    const state = proposalTurnState(input.turn);
    const round = (state.reviewRounds.get(key) ?? 0) + 1;
    let verdict: ReviewJudgeVerdict;
    try {
      verdict = await judge(resolved.provider, resolved.modelId, buildReviewState(input, facts), input.turn.signal);
    } catch (error) {
      deps.log?.(`author review skipped: ${error instanceof Error ? error.message : String(error)}`);
      return { pass: true };
    }
    const gaps = DRAFT_REVIEW_DIMENSIONS.filter((dim) => !verdict[dim].pass);
    if (gaps.length === 0) {
      state.reviewRounds.delete(key);
      return { pass: true };
    }
    if (round >= DRAFT_REVIEW_MAX_ROUNDS) {
      state.reviewRounds.delete(key);
      deps.log?.(`author review: showing draft after round ${round} with gaps for ${key}: ${gaps.join(', ')}`);
      return { pass: true };
    }
    state.reviewRounds.set(key, round);
    return {
      pass: false,
      failure: bounceFailure(input.toolName, round, gaps.map((dim) => `${dim}: ${verdict[dim].reason}`), gaps),
    };
  };
}
