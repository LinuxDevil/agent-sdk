/**
 * The three sampling numbers of `fields.modelSettings` (C03): temperature,
 * topP and max output tokens. Each write merges into the existing
 * `modelSettings` object — `patch` would replace it wholesale — and the
 * object is dropped entirely once its last key is cleared, so an emptied
 * form emits no `modelSettings:` line in the YAML.
 */
import type { AgentFields } from '../../../graph/v2/types';
import type { KindFieldsProps } from '../index';
import { OptionalNumberField } from '../../fields/OptionalNumberField';

/** `fields.modelSettings`, present. */
type ModelSettings = NonNullable<AgentFields['modelSettings']>;

/** Props for {@link ModelSettingsFields}: the current object plus the node's `patch`. */
export interface ModelSettingsFieldsProps {
  settings: AgentFields['modelSettings'];
  patch: KindFieldsProps<'agent'>['patch'];
}

/** One numeric key of `modelSettings` the form edits. */
type SettingKey = 'temperature' | 'topP' | 'maxTokens';

/** The sampling fields described above. */
export function ModelSettingsFields({ settings, patch }: ModelSettingsFieldsProps): JSX.Element {
  const set = (key: SettingKey) => (value: number | undefined) => {
    const next: ModelSettings = { ...settings };
    if (value === undefined) delete next[key];
    else next[key] = value;
    patch({ modelSettings: Object.keys(next).length === 0 ? undefined : next });
  };
  return (
    <>
      <OptionalNumberField
        id="node-agent-temperature"
        label="Temperature"
        value={settings?.temperature}
        onChange={set('temperature')}
        min={0}
        max={2}
        step={0.1}
        help="Leave empty for the provider default."
      />
      <OptionalNumberField
        id="node-agent-top-p"
        label="Top P"
        value={settings?.topP}
        onChange={set('topP')}
        min={0}
        max={1}
        step={0.05}
      />
      <OptionalNumberField
        id="node-agent-max-output-tokens"
        label="Max output tokens"
        value={settings?.maxTokens}
        onChange={set('maxTokens')}
        min={1}
        integer
      />
    </>
  );
}
