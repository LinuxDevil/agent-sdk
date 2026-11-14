/**
 * The `cron` trigger's Inspector sub-form: the five-field cron expression
 * (mono input flagged by `isCron`), the optional IANA time zone with a
 * `<datalist>` of `Intl.supportedValuesOf('timeZone')` when the runtime
 * offers it, the fixed prompt and the "One shared session" switch.
 */
import type { ChangeEvent } from 'react';
import { Field } from '../../../ui/Field';
import { Input, Switch, Textarea } from '../../../ui/controls';
import { isCron, isTimeZone } from '../../../graph/v2/kinds/trigger';
import type { TriggerSpec } from '../../../graph/v2/specTypes';
import type { KindFieldsProps } from '../index';

const CRON_ERROR = 'Use five fields: minute hour day month weekday';
const TIMEZONE_ERROR = 'Unknown time zone';
const PROMPT_ERROR = 'Enter what the agent should do';

/**
 * The IANA zone names for the datalist — `Intl.supportedValuesOf` is
 * ES2024 and missing in older jsdom, so a guarded lookup degrades to no
 * suggestions instead of crashing the form.
 */
const TIMEZONES: readonly string[] = (() => {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] };
  try {
    return typeof intl.supportedValuesOf === 'function' ? intl.supportedValuesOf('timeZone') : [];
  } catch {
    return [];
  }
})();

/** Props for the per-type sub-forms: the variant's own `item` plus the node's `patch`. */
export interface TriggerSubFormProps<T extends TriggerSpec> {
  item: T;
  patch: KindFieldsProps<'trigger'>['patch'];
}

/** The `cron` sub-form described above. */
export function CronForm({ item, patch }: TriggerSubFormProps<Extract<TriggerSpec, { type: 'cron' }>>): JSX.Element {
  const cronError = isCron(item.cron) ? undefined : CRON_ERROR;
  const timezoneError =
    item.timezone !== undefined && item.timezone !== '' && !isTimeZone(item.timezone)
      ? TIMEZONE_ERROR
      : undefined;
  return (
    <>
      <Field
        id="node-trigger-cron"
        label="Schedule"
        required
        error={cronError}
        hint="For example 0 9 * * 1-5 runs at 09:00 on weekdays."
      >
        <Input
          className="input-mono"
          value={item.cron}
          onChange={(event: ChangeEvent<HTMLInputElement>) => patch({ cron: event.target.value })}
        />
      </Field>
      <Field id="node-trigger-timezone" label="Time zone" error={timezoneError} hint="Defaults to the server's zone.">
        <Input
          list="node-trigger-timezone-list"
          value={item.timezone ?? ''}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            patch({ timezone: event.target.value === '' ? undefined : event.target.value })
          }
        />
        <datalist id="node-trigger-timezone-list">
          {TIMEZONES.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
      </Field>
      <Field
        id="node-trigger-prompt"
        label="Prompt"
        required
        error={item.prompt.trim() === '' ? PROMPT_ERROR : undefined}
      >
        <Textarea
          rows={3}
          value={item.prompt}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => patch({ prompt: event.target.value })}
        />
      </Field>
      <Field
        id="node-trigger-shared-session"
        label="One shared session"
        inline
        hint="Shared session is used by `lousho dev` only."
      >
        <Switch
          checked={item.sharedSession ?? false}
          onChange={(on) => patch({ sharedSession: on ? true : undefined })}
        />
      </Field>
    </>
  );
}
