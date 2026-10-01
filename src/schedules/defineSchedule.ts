import type { SimpleAgent } from '../createAgent';
import { SDKError } from '../execution/errors';
import { CronExpressionError, parseCronExpression } from '../triggers/cronExpression';

/** What a `run` schedule receives each time it fires. */
export interface ScheduleContext {
  /** The agent the schedules belong to. */
  agent: SimpleAgent;
  /** The scheduled fire time. */
  firedAt: Date;
  /** The schedule's name. */
  name: string;
}

interface ScheduleBase {
  /** 5-field cron expression or `@hourly` / `@daily` / `@weekly` / `@monthly`. */
  cron: string;
  /** IANA time zone the expression is evaluated in. Defaults to the machine's local zone. */
  timezone?: string;
  /** Defaults to the file name in an agent directory's `schedules/`. */
  name?: string;
}

/** Send `prompt` to the agent as a new turn on every fire. */
export interface PromptScheduleInput extends ScheduleBase {
  prompt: string;
  run?: never;
}

/** Call `run` on every fire. */
export interface RunScheduleInput extends ScheduleBase {
  run: (ctx: ScheduleContext) => Promise<void>;
  prompt?: never;
}

/** The input of {@link defineSchedule}: `cron` plus exactly one of `prompt` or `run`. */
export type ScheduleInput = PromptScheduleInput | RunScheduleInput;

/** A validated schedule. Create it with {@link defineSchedule}. */
export type DefinedSchedule = Readonly<ScheduleInput>;

const defined = new WeakSet<object>();

/** True when `value` was created by {@link defineSchedule}. */
export function isDefinedSchedule(value: unknown): value is DefinedSchedule {
  return typeof value === 'object' && value !== null && defined.has(value);
}

function invalid(problem: string, cause?: unknown): never {
  throw new SDKError(`defineSchedule: ${problem}`, 'LOUSHY_SCHEDULE_INVALID', cause === undefined ? {} : { cause });
}

/**
 * Declares a schedule: a cron expression plus what to do when it fires.
 * Validated now, so a bad expression fails at definition (or agent-directory
 * load) time, not at the first fire. Put one per file in `schedules/` of an
 * agent directory, or pass them to `startSchedules()`.
 *
 * @example
 * ```ts
 * export default defineSchedule({ cron: '0 9 * * MON-FRI', timezone: 'Europe/Paris', prompt: 'Summarise yesterday.' });
 * ```
 */
export function defineSchedule(input: ScheduleInput): DefinedSchedule {
  const hasPrompt = typeof input.prompt === 'string' && input.prompt.trim() !== '';
  const hasRun = typeof input.run === 'function';
  if (hasPrompt === hasRun) invalid("pass exactly one of 'prompt' (text sent to the agent) or 'run' (a function).");
  try {
    parseCronExpression(input.cron, input.timezone);
  } catch (error) {
    if (error instanceof CronExpressionError || error instanceof RangeError) invalid(error.message, error);
    throw error;
  }
  const schedule = Object.freeze({ ...input });
  defined.add(schedule);
  return schedule;
}
