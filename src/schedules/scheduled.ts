import type { SimpleAgent } from '../createAgent';
import { SDKError } from '../execution/errors';
import type { DefinedSchedule } from './defineSchedule';
import { fireSchedule, scheduleName } from './fireSchedule';

/** The part of a Workers `ScheduledController` that {@link handleScheduled} reads. */
export interface ScheduledController {
  /** The cron expression of the trigger that fired, exactly as written under `[triggers] crons`. */
  cron: string;
  /** When it was scheduled to fire, in epoch milliseconds. */
  scheduledTime?: number;
}

/** The part of a Workers `ExecutionContext` that {@link handleScheduled} uses. */
export interface ScheduledContext {
  waitUntil(promise: Promise<unknown>): void;
}

const normalize = (cron: string): string => cron.trim().split(/\s+/).join(' ');

/** `console.error` with the schedule name and the SDK error code. */
export function logScheduleFailure(name: string, error: unknown): void {
  const code = error instanceof SDKError ? error.code : 'LOUSHO_GENERIC_ERROR';
  console.error(`[lousho schedule] '${name}' failed [${code}]:`, error);
}

/**
 * Runs the `schedules` whose `cron` equals `controller.cron` (the trigger a
 * Cloudflare Worker's `scheduled()` was invoked for), inside `ctx.waitUntil`.
 * A prompt schedule is a turn under the session `schedule:<name>`, so its runs
 * can be read back from the agent's store. A failing schedule is logged with
 * `console.error` (name and error code) and never stops the others; the
 * returned promise never rejects.
 *
 * @example
 * ```ts
 * const agent = createAgent({ provider: mockModel(['Done.']), prompt: 'You report.' });
 * const schedules = [defineSchedule({ name: 'report', cron: '0 9 * * MON', prompt: 'Weekly report.' })];
 * export default {
 *   scheduled: (controller: ScheduledController, _env: unknown, ctx: ScheduledContext) =>
 *     handleScheduled(agent, schedules, controller, ctx),
 * };
 * ```
 */
export function handleScheduled(
  agent: SimpleAgent,
  schedules: readonly DefinedSchedule[],
  controller: ScheduledController,
  ctx: ScheduledContext
): Promise<void> {
  const firedAt = new Date(controller.scheduledTime ?? Date.now());
  const runs = schedules
    .map((schedule, index) => ({ schedule, name: scheduleName(schedule, index) }))
    .filter(({ schedule }) => normalize(schedule.cron) === normalize(controller.cron))
    .map(({ schedule, name }) =>
      fireSchedule(agent, schedule, name, firedAt, `schedule:${name}`).catch((error: unknown) =>
        logScheduleFailure(name, error)
      )
    );
  const done = Promise.all(runs).then(() => undefined);
  ctx.waitUntil(done);
  return done;
}
