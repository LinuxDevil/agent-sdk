import type { SimpleAgent } from '../createAgent';
import { SDKError } from '../execution/errors';
import type { DefinedSchedule } from './defineSchedule';

/** The name a schedule runs under: its own `name`, else `schedule-<position>`. */
export function scheduleName(schedule: DefinedSchedule, index: number): string {
  return schedule.name ?? `schedule-${index + 1}`;
}

/**
 * The session id a prompt schedule's turn runs in: `schedule-<name>-<fire time>`
 * (one session per fire, so a daily job does not replay every earlier report),
 * or `schedule-<name>` when the schedule opted into a `sharedSession`. Always a
 * valid session id (letters, digits, `_`, `-`; at most 128 characters).
 */
function scheduleSessionId(name: string, firedAt: Date, shared = false): string {
  const safe = name.replace(/[^A-Za-z0-9_-]/g, '-');
  if (shared) return `schedule-${safe.slice(0, 119)}`;
  const stamp = firedAt.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '');
  return `schedule-${safe.slice(0, 100)}-${stamp}`;
}

/** Options of {@link fireSchedule}. */
export interface FireScheduleOptions {
  /** The name passed to `run` and used in errors. Defaults to the schedule's `name`, else `'schedule'`. */
  name?: string;
  /** The fire time passed to `run`. Defaults to now. */
  firedAt?: Date;
  /** The session a prompt schedule's turn runs in. Defaults to `schedule-<name>-<fire time>`, or `schedule-<name>` for a `sharedSession` schedule (see {@link scheduleSessionId}). */
  sessionId?: string;
}

/**
 * Sends in the fire's own session when the agent has a checkpoint store; an
 * agent without one (nothing to read a session back from) runs the turn
 * ephemerally, as before. That error is thrown before any model call, so the
 * retry cannot double-run the turn.
 */
async function sendInFireSession(agent: SimpleAgent, prompt: string, sessionId: string) {
  try {
    return await agent.send(prompt, { sessionId });
  } catch (error) {
    if (error instanceof SDKError && error.code === 'LOUSHO_CONFIG_MISSING_CHECKPOINT_STORE') return agent.send(prompt);
    throw error;
  }
}

/**
 * Fires `schedule` once, now: calls its `run`, or sends its `prompt` as an
 * agent turn. This is what `startSchedules()` does on each tick; use it to run
 * a schedule on demand (an ops "run now", a test). Rejects when `run` throws,
 * when the turn throws, or with `LOUSHO_SCHEDULE_RUN_INCOMPLETE` when a prompt
 * turn ends with any `finishReason` other than `'stop'` (for example
 * `'awaiting-approval'`, whose `approvalId` the message names, or
 * `'output-invalid'`).
 *
 * @example
 * ```ts
 * const report = defineSchedule({ name: 'report', cron: '@daily', prompt: 'Run the daily report.' });
 * await fireSchedule(agent, report);
 * ```
 */
export async function fireSchedule(agent: SimpleAgent, schedule: DefinedSchedule, options: FireScheduleOptions = {}): Promise<void> {
  const name = options.name ?? schedule.name ?? 'schedule';
  const firedAt = options.firedAt ?? new Date();
  if (schedule.run) return schedule.run({ agent, firedAt, name });
  const prompt = schedule.prompt as string;
  const result =
    options.sessionId === undefined
      ? await sendInFireSession(agent, prompt, scheduleSessionId(name, firedAt, schedule.sharedSession === true))
      : await agent.send(prompt, { sessionId: options.sessionId });
  if (result.finishReason === 'stop') return;
  const detail = [
    result.approvalId && `approval '${result.approvalId}' is pending`,
    result.outputError?.message,
  ].filter(Boolean).join('; ');
  throw new SDKError(
    `schedule '${name}' ended with finishReason '${result.finishReason}'${detail ? ` (${detail})` : ''}`,
    'LOUSHO_SCHEDULE_RUN_INCOMPLETE'
  );
}
