import { SDKError } from '../execution/errors';
import type { AgentSpecTrigger } from '../spec/schema';
import { defineSchedule, type DefinedSchedule } from './defineSchedule';

function invalidTrigger(name: string, problem: string, cause?: unknown): never {
  throw new SDKError(`triggers: cron trigger '${name}': ${problem}`, 'LOUSHY_SCHEDULE_INVALID', cause === undefined ? {} : { cause });
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

function requiredFields(trigger: AgentSpecTrigger, name: string): { cron: string; prompt: string } {
  const cron = text(trigger.cron);
  const prompt = text(trigger.input) ?? text(trigger.prompt);
  if (!cron) return invalidTrigger(name, "needs a 'cron' expression string.");
  if (!prompt) return invalidTrigger(name, "needs an 'input' string, the prompt sent to the agent.");
  return { cron, prompt };
}

function toSchedule(trigger: AgentSpecTrigger, name: string): DefinedSchedule {
  const fields = requiredFields(trigger, name);
  try {
    return defineSchedule({ name, ...fields, timezone: text(trigger.timezone) });
  } catch (error) {
    return invalidTrigger(name, error instanceof SDKError ? error.detail : String(error), error);
  }
}

/**
 * The schedules of an AgentSpec's `{ type: 'cron' }` triggers:
 * `{ type: 'cron', cron: '0 9 * * MON', input: 'Weekly report.', name?, timezone? }`
 * (`prompt` is accepted for `input`). A trigger without a valid `cron` or
 * `input` throws a `LOUSHY_SCHEDULE_INVALID` SDKError naming it.
 */
export function specSchedules(triggers: readonly AgentSpecTrigger[] | undefined): DefinedSchedule[] {
  return (triggers ?? [])
    .filter((trigger) => trigger.type === 'cron')
    .map((trigger, index) => {
      const name = text(trigger.name) ?? `cron-${index + 1}`;
      return toSchedule(trigger, name);
    });
}
