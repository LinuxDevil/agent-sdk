/**
 * The `spec.abortListeners` section of AgentSpec v2: events that cancel a
 * queued or running run (PLAN §3.1, R03a). One entry watches a `webhook` or
 * `channel` trigger: when the trigger fires and `when` matches the event,
 * every run whose own trigger event matches `match` is aborted, within
 * `scope`. The schema validates the data only - evaluating the listeners is
 * the trigger host's job (R03b). Browser-safe: no `node:*` imports.
 */
import { z } from 'zod';
import { typeErrors } from '../../utils/zodCompat';

/** Which runs an abort listener cancels once its trigger fires and both expressions match. */
export type AbortListenerScope = 'queued' | 'running' | 'both';

/**
 * One `spec.abortListeners` entry. `id` is its `abort:<id>` canvas node id.
 * `triggerId` names the `webhook` or `channel` trigger whose events are
 * watched; `when` is a safeExpression over the incoming event that decides
 * whether it counts; `match` is a safeExpression pairing the trigger event
 * with a run's own event (e.g. `event.pr == run.event.pr`); `scope` limits
 * the cancellation to queued runs, running runs, or both.
 */
export interface AbortListenerSpec {
  /** Stable id (`abort:<id>` on the canvas). */
  id: string;
  /** The `webhook` or `channel` trigger whose events are watched. */
  triggerId: string;
  /** safeExpression over the trigger event; the listener only fires when it is truthy. */
  when: string;
  /** safeExpression pairing the trigger event with a run's event (`run.event`). */
  match: string;
  /** Which runs the match cancels. */
  scope: AbortListenerScope;
}

const nonEmptyString = z.string(typeErrors({ required: 'is required', invalid: 'must be a string' })).min(1, 'must not be empty');

/**
 * One `spec.abortListeners` entry (zod): a strict object so typos surface.
 * The cross-field checks - unique ids, the watched trigger existing and
 * being a webhook/channel, `when`/`match` parsing - need the whole spec and
 * live in schema.ts's `checkAbortListeners`.
 */
export const abortListenerSpecSchema: z.ZodType<AbortListenerSpec> = z
  .object({
    id: z
      .string(typeErrors({ required: 'is required', invalid: 'must be a string' }))
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, 'must be 1-64 letters, digits, dashes or underscores, starting with a letter or digit'),
    triggerId: nonEmptyString,
    when: nonEmptyString.max(2000, 'must be at most 2000 characters'),
    match: nonEmptyString.max(2000, 'must be at most 2000 characters'),
    scope: z.enum(['queued', 'running', 'both'], typeErrors({ invalid: "must be 'queued', 'running' or 'both'" })),
  })
  .strict();

/** The `spec.abortListeners` list (zod): at most 20 entries. */
export const abortListenerListSchema: z.ZodType<AbortListenerSpec[]> = z
  .array(abortListenerSpecSchema)
  .max(20, 'must have at most 20 entries');
