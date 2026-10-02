/**
 * Cron trigger adapter (LOU-T5, LOU-D13).
 *
 * Fires an agent run on a schedule rather than in response to an inbound
 * request. The schedule is either a fixed interval (`intervalMs`) or a
 * standard 5-field cron expression (`cron`, with an optional IANA
 * `timezone`), parsed by the dependency-free parser in ../cronExpression.ts.
 *
 * Reply semantics: there is no caller waiting on a response the way an
 * HTTP request or a Slack message is - so results are handed to the
 * `onResult` sink supplied at construction time instead of a `reply()`
 * method (which is intentionally left undefined here; see types.ts's doc
 * comment).
 */
import type { ExecutionResult } from '../../execution/AgentExecutor';
import { RunnableAgent, TriggerAdapter, TriggerContext, TriggerHandle } from '../types';

import { CronSchedule, parseCronExpression } from '../cronExpression';
import { SDKError } from '../../execution/errors';

interface CronTriggerAdapterBaseOptions {
  /** The input to run the agent with on each tick. */
  input: string;
  /** Called with the outcome of each scheduled run (success or failure). */
  onResult: (result: ExecutionResult | undefined, error: unknown, context: TriggerContext) => void;
  /** If true, fires once immediately in addition to the schedule. Defaults to false. */
  fireImmediately?: boolean;
}

/** Fire every `intervalMs` milliseconds. */
export interface CronIntervalOptions extends CronTriggerAdapterBaseOptions {
  /** How often to fire, in milliseconds. Must be a positive number. */
  intervalMs: number;
  cron?: never;
  timezone?: never;
}

/** Fire on a cron expression. */
export interface CronExpressionOptions extends CronTriggerAdapterBaseOptions {
  /**
   * Standard 5-field cron expression (`minute hour day-of-month month day-of-week`)
   * or `@hourly` / `@daily` / `@weekly` / `@monthly`. Supports `*`, lists, ranges,
   * steps and month/weekday names; 0 and 7 are both Sunday.
   */
  cron: string;
  /** IANA time zone the expression is evaluated in (e.g. `'America/New_York'`). Defaults to the machine's local zone. */
  timezone?: string;
  intervalMs?: never;
}

/**
 * Options for {@link CronTriggerAdapter}: pass either `intervalMs` or `cron`.
 *
 * @example
 * ```ts
 * new CronTriggerAdapter({
 *   cron: '0 9 * * MON-FRI',
 *   timezone: 'Europe/Paris',
 *   input: 'Summarise yesterday',
 *   onResult: (result) => console.log(result?.text),
 * });
 * ```
 */
export type CronTriggerAdapterOptions = CronIntervalOptions | CronExpressionOptions;

/** setTimeout stores its delay in a signed 32-bit int; anything larger fires immediately. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

type Schedule = { kind: 'interval'; intervalMs: number } | { kind: 'cron'; schedule: CronSchedule };

function resolveSchedule(options: CronTriggerAdapterOptions): Schedule {
  const hasInterval = options.intervalMs !== undefined;
  if (hasInterval === (options.cron !== undefined)) {
    throw new SDKError("CronTriggerAdapter: pass exactly one of options.intervalMs or options.cron (e.g. { cron: '*/5 * * * *' }).", 'LOUSHO_TRIGGER_INVALID');
  }
  if (options.cron !== undefined) {
    return { kind: 'cron', schedule: parseCronExpression(options.cron, options.timezone) };
  }
  const intervalMs = options.intervalMs as number;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new SDKError('CronTriggerAdapter: options.intervalMs must be a positive number', 'LOUSHO_TRIGGER_INVALID');
  }
  return { kind: 'interval', intervalMs };
}

/** Don't keep the process alive solely because a cron trigger is listening; callers that want that hold their own handle. */
function unref(timer: NodeJS.Timeout): void {
  if (typeof timer.unref === 'function') timer.unref();
}

export class CronTriggerAdapter implements TriggerAdapter {
  public readonly type = 'cron';

  private readonly schedule: Schedule;

  constructor(private readonly options: CronTriggerAdapterOptions) {
    this.schedule = resolveSchedule(options);
  }

  public listen(
    agent: RunnableAgent,
    onEvent: (input: string, context: TriggerContext) => Promise<ExecutionResult>
  ): TriggerHandle {
    void agent;
    let tickCount = 0;

    const fire = () => {
      const context: TriggerContext = { firedAt: new Date().toISOString(), tick: tickCount++ };
      onEvent(this.options.input, context)
        .then((result) => this.options.onResult(result, undefined, context))
        .catch((error: unknown) => this.options.onResult(undefined, error, context));
    };

    if (this.options.fireImmediately) {
      fire();
    }
    return this.schedule.kind === 'interval'
      ? startInterval(this.schedule.intervalMs, fire)
      : startCron(this.schedule.schedule, fire);
  }
}

function startInterval(intervalMs: number, fire: () => void): TriggerHandle {
  const timer = setInterval(fire, intervalMs);
  unref(timer);
  return { stop: () => clearInterval(timer) };
}

/**
 * One timer, always set to the next run. Each run is computed from the
 * previous scheduled time (cron times are absolute, so nothing drifts) and
 * strictly after it (so nothing fires twice). Delays beyond setTimeout's
 * ~24.8 day limit are chained.
 */
function startCron(schedule: CronSchedule, fire: () => void): TriggerHandle {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const waitUntil = (target: number) => {
    const delay = Math.max(0, target - Date.now());
    timer = setTimeout(() => {
      if (stopped) return;
      if (Date.now() < target) {
        waitUntil(target);
        return;
      }
      // Re-arm first so a throwing handler can never end the schedule. If the
      // process was suspended past later runs, skip them rather than firing a burst.
      arm(new Date(Math.max(target, Date.now())));
      fire();
    }, Math.min(delay, MAX_TIMEOUT_MS));
    unref(timer);
  };

  const arm = (after: Date) => {
    if (!stopped) waitUntil(schedule.nextRun(after).getTime());
  };

  arm(new Date());
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
