import { SDKError } from '../execution/errors';
import type { AgentSpecTrigger } from '../spec/schema';
import { defineSchedule, type DefinedSchedule } from './defineSchedule';

function invalidTrigger(name: string, problem: string, cause?: unknown): never {
  throw new SDKError(`triggers: cron trigger '${name}': ${problem}`, 'LOUSHY_SCHEDULE_INVALID', cause === undefined ? {} : { cause });
}

/**
 * The schedules of an AgentSpec's `{ type: 'cron' }` triggers:
 * `{ type: 'cron', cron: '0 9 * * MON', input: 'Weekly report.', name?, timezone? }`
 * (`prompt` is accepted for `input`). A trigger without a valid `cron` or
 * `input` throws a `LOUSHY_SCHEDULE_INVALID` SDKError naming it.
 */
export function specSchedules(triggers: readonly AgentSpecTrigger[] | undefined): DefinedSchedule[] {
  const cronTriggers = (triggers ?? []).filter((trigger) => trigger.type === 'cron');
  return cronTriggers.map((trigger, index) => {
    const name = typeof trigger.name === 'string' && trigger.name ? trigger.name : `cron-${index + 1}`;
    const prompt = trigger.input ?? trigger.prompt;
    if (typeof trigger.cron !== 'string') return invalidTrigger(name, "needs a 'cron' expression string.");
    if (typeof prompt !== 'string') return invalidTrigger(name, "needs an 'input' string, the prompt sent to the agent.");
    try {
      const timezone = typeof trigger.timezone === 'string' ? { timezone: trigger.timezone } : {};
      return defineSchedule({ name, cron: trigger.cron, prompt, ...timezone });
    } catch (error) {
      return invalidTrigger(name, error instanceof SDKError ? error.detail : String(error), error);
    }
  });
}
