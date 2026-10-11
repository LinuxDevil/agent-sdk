import { createAgentConfigOf, type SimpleAgent } from '../createAgent';
import { SDKError } from '../execution/errors';
import { claimOnce } from '../execution/runLease';
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
  return `schedule-${safe.slice(0, 100)}-${fireStamp(firedAt)}`;
}

/** The fire time as it appears in ids: `2026-10-10T030000Z`. */
function fireStamp(firedAt: Date): string {
  return firedAt.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '');
}

/** How long a fire's claim lasts: replicas firing the same tick do so within seconds of each other. */
const FIRE_CLAIM_TTL_MS = 10 * 60_000;

/**
 * Claims this fire of `name` (one per schedule and fire time) in the agent's
 * checkpoint store, so of several replicas running `startSchedules()` on one
 * store only the first fires the tick. `true` without a store that has leases.
 */
function claimFire(agent: SimpleAgent, name: string, firedAt: Date): Promise<boolean> {
  const checkpoints = createAgentConfigOf(agent)?.store?.checkpoints;
  // A name with other characters gets a hash of itself, so `daily report` and `daily-report` claim apart.
  const safe = name.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 100);
  const key = safe === name ? safe : `${safe}-${nameHash(name)}`;
  return claimOnce(checkpoints, `schedule-${key}-${fireStamp(firedAt)}.fire`, FIRE_CLAIM_TTL_MS);
}

/** A short FNV-1a hash of `name`, as hex (no Node crypto: Workers fire schedules too). */
function nameHash(name: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) hash = Math.imul(hash ^ name.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(16);
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
 * a schedule on demand (an ops "run now", a test). With an agent `store` whose
 * checkpoints have leases (file, SQLite, KV, memory), each fire time is claimed
 * there first, so replicas that fire the same tick run it once: the others
 * resolve without running anything. Rejects when `run` throws,
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
  // Another replica sharing the agent's store already fired this tick.
  if (!(await claimFire(agent, name, firedAt))) return;
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
