/**
 * The `channel` trigger's Inspector sub-form: the channel picker (the six
 * `ChannelKind`s, no unset) and the `secrets` map as SecretRef rows.
 * `usePrefilledRows` shows the channel's required keys as blank rows
 * while the map is empty — keys only, values are never prefilled — and
 * switching channel resets the map so another platform's keys are not
 * carried over.
 */
import { Field } from '../../../ui/Field';
import { Input } from '../../../ui/controls';
import { CHANNEL_LABELS, CHANNEL_SECRET_KEYS } from '../../../graph/v2/kinds/trigger';
import type { ChannelKind, TriggerSpec } from '../../../graph/v2/specTypes';
import { ChoiceField } from '../../fields/ChoiceField';
import { KeyValueField } from '../../fields/KeyValueField';
import { usePrefilledRows } from '../../fields/usePrefilledRows';
import type { TriggerSubFormProps } from './CronForm';

type ChannelItem = Extract<TriggerSpec, { type: 'channel' }>;

const CHANNEL_OPTIONS: { value: ChannelKind; label: string }[] = (
  Object.entries(CHANNEL_LABELS) as [ChannelKind, string][]
).map(([value, label]) => ({ value, label }));

/** The `channel` sub-form described above. */
export function ChannelForm({
  item,
  patch,
}: TriggerSubFormProps<ChannelItem>): JSX.Element {
  const required = CHANNEL_SECRET_KEYS[item.channel] ?? [];
  const missing = required.filter((key) => !(key in item.secrets));
  const rows = usePrefilledRows(required, item.secrets);
  return (
    <>
      <ChoiceField
        id="node-trigger-channel"
        label="Channel"
        value={item.channel}
        options={CHANNEL_OPTIONS}
        onChange={(channel) => {
          if (channel !== undefined) patch({ channel, secrets: {} });
        }}
      />
      <KeyValueField
        id="node-trigger-secrets"
        label="Secrets"
        valueKind="secret"
        value={rows.view}
        // Blank suggestion rows never reach the spec; the item's values are SecretRefs.
        onChange={(next) => patch({ secrets: rows.onChange(next) as ChannelItem['secrets'] })}
        error={missing.length > 0 ? `Add ${missing.join(', ')}` : undefined}
        help={required.length > 0 ? `Required: ${required.join(', ')}` : 'This channel needs no secrets.'}
      />
      <Field id="node-trigger-filter" label="Filter">
        <Input
          className="input-mono"
          value={item.filter ?? ''}
          onChange={(event) =>
            patch({ filter: event.target.value === '' ? undefined : event.target.value })
          }
        />
      </Field>
    </>
  );
}
