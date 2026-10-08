import type { SimpleAgent } from '../createAgent';
import { parseCronExpression } from '../triggers/cronExpression';
import type { DefinedSchedule } from './defineSchedule';
import { fireSchedule, scheduleName } from './fireSchedule';

/** setTimeout stores its delay in a signed 32-bit int; longer waits are chained. */
const MAX_DELAY_MS = 2 ** 31 - 1;

export interface StartSchedulesOptions {
  /** The clock, in epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** Runs `fn` after `ms`; returns a function that cancels it. Defaults to a `setTimeout` that is unref'd unless `keepAlive`. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  /**
   * Receives a failed run (a `run` that threw, a prompt turn that threw or
   * ended with a `finishReason` other than `'stop'`, as
   * `LOUSHO_SCHEDULE_RUN_INCOMPLETE`), and a fire skipped because the previous
   * one is still running. Defaults to `console.error`.
   */
  onError?: (error: unknown, schedule: { name: string }) => void;
  /**
   * `true` keeps the Node process alive while schedules are running, for a
   * script that only runs schedules. Default `false`: the timers are unref'd,
   * so they never hold open a process that is otherwise done (a server, a
   * test). Ignored when `setTimer` is given.
   */
  keepAlive?: boolean;
}

/** Stops every schedule started by {@link startSchedules}. */
export interface RunningSchedules {
  /** Clears the timers so nothing fires again; the promise resolves once the runs already in flight have settled. */
  stop(): Promise<void>;
}

function timerFactory(keepAlive: boolean): (fn: () => void, ms: number) => () => void {
  return (fn, ms) => {
    const timer = setTimeout(fn, ms);
    if (!keepAlive && typeof timer.unref === 'function') timer.unref();
    return () => clearTimeout(timer);
  };
}

type ResolvedOptions = Required<Omit<StartSchedulesOptions, 'keepAlive'>>;

/** One schedule's loop: one timer, always set to the next fire; a fire never overlaps its own previous one. */
function startOne(agent: SimpleAgent, schedule: DefinedSchedule, name: string, options: ResolvedOptions): () => Promise<void> {
  const cron = parseCronExpression(schedule.cron, schedule.timezone);
  let cancel: (() => void) | undefined;
  let stopped = false;
  let running: Promise<void> | undefined;

  const arm = (): void => {
    if (!stopped) wait(cron.nextRun(new Date(options.now())).getTime());
  };
  const wait = (target: number): void => {
    cancel = options.setTimer(() => {
      if (stopped) return;
      if (options.now() < target) return wait(target);
      arm();
      if (running) return options.onError(new Error(`schedule '${name}' skipped: its previous run is still going`), { name });
      running = fireSchedule(agent, schedule, { name, firedAt: new Date(target) })
        .catch((error: unknown) => options.onError(error, { name }))
        .finally(() => (running = undefined));
    }, Math.min(Math.max(0, target - options.now()), MAX_DELAY_MS));
  };

  arm();
  return async () => {
    stopped = true;
    cancel?.();
    await running;
  };
}

/**
 * Runs `schedules` against `agent` until `stop()`: each fires on its cron
 * expression, a failing run is reported to `onError` and never stops the
 * others, and a schedule never overlaps its own still-running previous fire.
 * Missed fires (a suspended process) are skipped, not replayed. The timers do
 * not keep the process alive unless `keepAlive: true`; `stop()` resolves once
 * the runs in flight have finished.
 *
 * @example
 * ```ts
 * const running = startSchedules(agent, [defineSchedule({ cron: '@daily', prompt: 'Run the daily report.' })], { keepAlive: true });
 * process.once('SIGTERM', () => void running.stop().then(() => agent.close()));
 * ```
 */
export function startSchedules(
  agent: SimpleAgent,
  schedules: readonly DefinedSchedule[],
  options: StartSchedulesOptions = {}
): RunningSchedules {
  const resolved: ResolvedOptions = {
    now: options.now ?? Date.now,
    setTimer: options.setTimer ?? timerFactory(options.keepAlive === true),
    onError: options.onError ?? ((error, { name }) => console.error(`[lousho schedule] '${name}':`, error)),
  };
  const stops = schedules.map((s, i) => startOne(agent, s, scheduleName(s, i), resolved));
  return { stop: () => Promise.all(stops.map((stop) => stop())).then(() => undefined) };
}
