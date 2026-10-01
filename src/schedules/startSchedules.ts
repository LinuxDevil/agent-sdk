import type { SimpleAgent } from '../createAgent';
import { parseCronExpression } from '../triggers/cronExpression';
import type { DefinedSchedule } from './defineSchedule';
import { fireSchedule, scheduleName } from './fireSchedule';

/** setTimeout stores its delay in a signed 32-bit int; longer waits are chained. */
const MAX_DELAY_MS = 2 ** 31 - 1;

export interface StartSchedulesOptions {
  /** The clock, in epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** Runs `fn` after `ms`; returns a function that cancels it. Defaults to an unref'd `setTimeout`. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  /** Receives a failed run, and a fire skipped because the previous one is still running. Defaults to `console.error`. */
  onError?: (error: unknown, schedule: { name: string }) => void;
}

/** Stops every schedule started by {@link startSchedules}. */
export interface RunningSchedules {
  stop(): void;
}

function defaultSetTimer(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearTimeout(timer);
}

/** One schedule's loop: one timer, always set to the next fire; a fire never overlaps its own previous one. */
function startOne(agent: SimpleAgent, schedule: DefinedSchedule, name: string, options: Required<StartSchedulesOptions>): () => void {
  const cron = parseCronExpression(schedule.cron, schedule.timezone);
  let cancel: (() => void) | undefined;
  let stopped = false;
  let running = false;

  const arm = (): void => {
    if (!stopped) wait(cron.nextRun(new Date(options.now())).getTime());
  };
  const wait = (target: number): void => {
    cancel = options.setTimer(() => {
      if (stopped) return;
      if (options.now() < target) return wait(target);
      arm();
      if (running) return options.onError(new Error(`schedule '${name}' skipped: its previous run is still going`), { name });
      running = true;
      fireSchedule(agent, schedule, name, new Date(target))
        .catch((error: unknown) => options.onError(error, { name }))
        .finally(() => (running = false));
    }, Math.min(Math.max(0, target - options.now()), MAX_DELAY_MS));
  };

  arm();
  return () => {
    stopped = true;
    cancel?.();
  };
}

/**
 * Runs `schedules` against `agent` until `stop()`: each fires on its cron
 * expression, a failing run is reported to `onError` and never stops the
 * others, and a schedule never overlaps its own still-running previous fire.
 * Missed fires (a suspended process) are skipped, not replayed.
 *
 * @example
 * ```ts
 * const running = startSchedules(agent, [defineSchedule({ cron: '@daily', prompt: 'Run the daily report.' })]);
 * process.once('SIGTERM', () => running.stop());
 * ```
 */
export function startSchedules(
  agent: SimpleAgent,
  schedules: readonly DefinedSchedule[],
  options: StartSchedulesOptions = {}
): RunningSchedules {
  const resolved: Required<StartSchedulesOptions> = {
    now: options.now ?? Date.now,
    setTimer: options.setTimer ?? defaultSetTimer,
    onError: options.onError ?? ((error, { name }) => console.error(`[loushy schedule] '${name}':`, error)),
  };
  const stops = schedules.map((s, i) => startOne(agent, s, scheduleName(s, i), resolved));
  return { stop: () => stops.forEach((stop) => stop()) };
}
