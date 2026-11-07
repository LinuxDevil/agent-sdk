/**
 * The review judge's input (PLAN §8.4, AA12): the `ReviewState` JSON the
 * review agent is asked its five questions over. `buildReviewState`
 * renders the turn's conversation (text only - tool parts, turn-context
 * blocks and `[UI event]` messages never reach the judge), the draft with
 * its instructions and change before/after strings clamped so a huge spec
 * cannot blow the review prompt up, and the catalog facts the judge
 * checks membership against.
 */
import type { AgentSpecV2 } from 'lousho';
import type { AuthorMessage, Requirement, SpecChange } from '../../../shared/authorWire';
import type { CatalogFacts } from '../proposal/catalogChecks';
import type { ReviewInput } from '../proposal/review';

/** The conversation-text budget the judge gets (research §6's `conversation_max_chars`). */
export const REVIEW_CONVERSATION_MAX_CHARS = 12_000;

/** The draft-instructions budget the judge gets (research §6's `system_prompt_max_chars`). */
export const REVIEW_INSTRUCTIONS_MAX_CHARS = 8_000;

/** The per-change before/after string budget: a clamped diff row still names what moved. */
const REVIEW_CHANGE_FIELD_MAX_CHARS = 500;

/**
 * The catalog name lists the review needs out of {@link CatalogFacts}:
 * builtin tools, guardrails and trigger types. Models and agent ids are
 * left out - the review cannot get the workspace's agent list, and model
 * availability is what the requirements rows already report.
 */
export type ReviewFacts = Pick<CatalogFacts, 'builtinTools' | 'guardrails' | 'triggerTypes'>;

/** What the judge answers its five questions over (`ReviewState` JSON is `judge`'s whole user message). */
export interface ReviewState {
  /** 'User: …\n\nAssistant: …' - text only, oldest first, '…'-prefixed when cut to budget. */
  conversation: string;
  draft: {
    kind: 'A new agent the user asked for' | 'A change to an existing agent; spec is the agent after the change';
    /** The proposed spec; string instructions clamped to {@link REVIEW_INSTRUCTIONS_MAX_CHARS} + '…'. */
    spec: AgentSpecV2;
    /** Updates only: the card's diff with `lines` dropped and before/after strings clamped. */
    changes?: SpecChange[];
  };
  facts: {
    /** The spec's readiness rows (`computeRequirements`), advisory like on the card. */
    requirements: Requirement[];
    builtinTools: string[];
    guardrails: string[];
    triggerTypes: string[];
  };
}

/** The entries of one message for the review conversation, or none when it carries no reviewable text. */
function messageEntries(message: AuthorMessage): string[] {
  if (message.role === 'user') {
    // uiEvent messages are app-written `[UI event]` text, not the user's voice.
    if (message.uiEvent !== undefined || message.text === '') return [];
    // `text` alone: the stored turnContext block is machine preamble, not conversation.
    return [`User: ${message.text}`];
  }
  const text = message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
  return text === '' ? [] : [`Assistant: ${text}`];
}

/**
 * The conversation for the judge: user and assistant text of
 * `messages`, oldest first, 'User:'/'Assistant:'-prefixed, joined by
 * blank lines. When the joined text exceeds `maxChars` the oldest end is
 * cut (the newest text always survives) and the result is prefixed '…'.
 */
export function conversationForReview(messages: readonly AuthorMessage[], maxChars: number): string {
  const joined = messages.flatMap(messageEntries).join('\n\n');
  if (joined.length <= maxChars) return joined;
  if (maxChars <= 1) return '…'.slice(0, Math.max(0, maxChars));
  return `…${joined.slice(joined.length - (maxChars - 1))}`;
}

/** `value` clamped to `maxChars` + '…' when it is a string over the budget; anything else passes through. */
function clampValue(value: unknown, maxChars: number): unknown {
  return typeof value === 'string' && value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

/** A change row for the judge: same row minus the `lines` diff, with long before/after strings clamped. */
function clampChange(change: SpecChange): SpecChange {
  const shown: SpecChange = {
    ...change,
    ...(change.before !== undefined && { before: clampValue(change.before, REVIEW_CHANGE_FIELD_MAX_CHARS) }),
    ...(change.after !== undefined && { after: clampValue(change.after, REVIEW_CHANGE_FIELD_MAX_CHARS) }),
  };
  delete shown.lines;
  return shown;
}

/** The spec the judge sees: identical except string instructions are clamped to the budget + '…'. */
function clampSpec(spec: AgentSpecV2): AgentSpecV2 {
  if (typeof spec.instructions !== 'string' || spec.instructions.length <= REVIEW_INSTRUCTIONS_MAX_CHARS) {
    return spec;
  }
  return { ...spec, instructions: `${spec.instructions.slice(0, REVIEW_INSTRUCTIONS_MAX_CHARS)}…` };
}

/**
 * The {@link ReviewState} for one propose call: the conversation is the
 * stored transcript plus this turn's user message (the assistant text of
 * the still-running turn is not persisted yet, which is fine), the draft
 * is the card's spec (and diff, for updates), and `facts.requirements`
 * are the readiness rows the propose tool already computed.
 */
export function buildReviewState(input: ReviewInput, facts: ReviewFacts): ReviewState {
  return {
    conversation: conversationForReview(
      [...input.turn.storedTranscript, input.turn.userMessage],
      REVIEW_CONVERSATION_MAX_CHARS
    ),
    draft: {
      kind:
        input.identity.kind === 'create'
          ? 'A new agent the user asked for'
          : 'A change to an existing agent; spec is the agent after the change',
      spec: clampSpec(input.spec),
      ...(input.identity.kind === 'update' && { changes: input.changes.map(clampChange) }),
    },
    facts: {
      requirements: input.requirements,
      builtinTools: [...facts.builtinTools],
      guardrails: [...facts.guardrails],
      triggerTypes: [...facts.triggerTypes],
    },
  };
}
