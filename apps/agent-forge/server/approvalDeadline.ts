/**
 * The deadline Studio gives a run paused for a human (an approval or an
 * `ask_question`), plus the copy the run's model reads back when nobody
 * answered in time: a question gets NO_ANSWER_TEXT as its answer, a tool
 * approval is denied with EXPIRED_APPROVAL_NOTE. Lives server-side in
 * RunManager's pause handling (runRegistry.ts); the deadline itself also
 * reaches the client on `PendingApprovalInfo.deadline` as the countdown's
 * target.
 */

/**
 * The closest a deadline may sit to now: a human needs at least this long
 * to notice the card and answer. Tests inject a smaller value through
 * `RunManagerOptions.minDeadlineMs`.
 */
export const MIN_DEADLINE_MS = 30_000;

/** The deadline when neither the SDK pause nor the run's own limits name one. */
export const DEFAULT_DEADLINE_MS = 15 * 60_000;

/** The `ask_question` answer the model sees when the deadline passed unanswered - it is told to proceed on its own. */
export const NO_ANSWER_TEXT =
  'No answer: nobody replied before the deadline. Continue with your best judgment and say what you assumed.';

/** The denial note a tool approval expires with - the model is told not to retry the same call blindly. */
export const EXPIRED_APPROVAL_NOTE =
  'Approval expired: nobody decided before the deadline. Do not retry this call unchanged.';

export interface ApprovalDeadlineInput {
  /** Now, ms epoch. */
  now: number;
  /** The SDK pause's own `expiresAt` (from `approvalTtlMs`, or an `ask` rule's `ttlMs`), ISO - absent when the pause never expires on its own. */
  expiresAt?: string;
  /** When the run the pause belongs to launched, ms epoch. */
  runStartedAt: number;
  /** The spec's `limits.maxDurationMs`: the pause dies with its run, so the run's end bounds it too. */
  maxDurationMs?: number;
  /**
   * Replaces `MIN_DEADLINE_MS` as the floor, and `DEFAULT_DEADLINE_MS` as
   * the no-bound fallback - the RunManager's test seam: a few dozen ms
   * makes an otherwise-unbounded pause resolve itself inside the test.
   */
  minDeadlineMs?: number;
}

/**
 * The ISO instant a pause resolves itself: the earliest bound that is
 * set (the SDK's `expiresAt`, the run's end at `runStartedAt +
 * maxDurationMs`), `now + DEFAULT_DEADLINE_MS` when neither is, and never
 * sooner than `now + minDeadlineMs` even when a bound is already past.
 */
export function approvalDeadline(input: ApprovalDeadlineInput): string {
  const bounds: number[] = [];
  const expiresAt = input.expiresAt === undefined ? NaN : Date.parse(input.expiresAt);
  if (!Number.isNaN(expiresAt)) bounds.push(expiresAt);
  if (input.maxDurationMs !== undefined && Number.isFinite(input.maxDurationMs)) {
    bounds.push(input.runStartedAt + input.maxDurationMs);
  }
  const floor = input.now + (input.minDeadlineMs ?? MIN_DEADLINE_MS);
  const bound = bounds.length > 0 ? Math.min(...bounds) : input.now + (input.minDeadlineMs ?? DEFAULT_DEADLINE_MS);
  return new Date(Math.max(floor, bound)).toISOString();
}
