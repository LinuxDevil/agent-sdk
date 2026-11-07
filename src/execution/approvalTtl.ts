/**
 * The approval-deadline helpers of `permissions.ts`, in a leaf module so
 * browser-safe spec files (spec/v2's `approvalTtlMs`/`ttlMs` checks) can use
 * them without pulling the run evaluator — and with it the provider and
 * sandbox stack — into a browser bundle. `permissions.ts` re-exports them,
 * so existing imports from it keep working.
 */

/**
 * The longest approval deadline (`approvalTtlMs`, an `ask` rule's `ttlMs`): 100
 * years. A longer one is a typo, not a deadline; leave it out for pauses that
 * never expire.
 */
export const MAX_APPROVAL_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;

/** Whether `value` is a valid approval deadline: a positive number of milliseconds, at most {@link MAX_APPROVAL_TTL_MS}. */
export function isApprovalTtl(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_APPROVAL_TTL_MS;
}

/** What a valid approval deadline is, for error messages: `... must be <this>, got ...`. */
export const APPROVAL_TTL_RULE = `a positive number of milliseconds, at most 100 years (${MAX_APPROVAL_TTL_MS})`;
