/**
 * The `{ integration }` form of the tool Inspector: the service picker
 * (GitHub, Jira, Slack or email) and the credentials map, edited as
 * SecretRef-or-string rows. `usePrefilledRows` shows the service's
 * required keys as blank rows while the map is empty — keys only, values
 * are never prefilled — and switching service resets the map so keys of
 * the old service are not carried over.
 */
import { INTEGRATION_CREDENTIALS, type IntegrationName } from '../../../graph/v2/specTypes';
import { ChoiceField } from '../../fields/ChoiceField';
import { KeyValueField } from '../../fields/KeyValueField';
import { usePrefilledRows } from '../../fields/usePrefilledRows';
import type { ToolSubFormProps } from './BuiltinForm';

const SERVICES: { value: IntegrationName; label: string }[] = [
  { value: 'github', label: 'GitHub' },
  { value: 'jira', label: 'Jira' },
  { value: 'slack', label: 'Slack' },
  { value: 'email', label: 'Email' },
];

/** The `{ integration }` sub-form described above. */
export function IntegrationForm({ item, patch }: ToolSubFormProps<'integration'>): JSX.Element {
  const spec = INTEGRATION_CREDENTIALS[item.integration];
  const rows = usePrefilledRows(spec.required, item.credentials);
  return (
    <>
      <ChoiceField
        id="node-tool-service"
        label="Service"
        value={item.integration}
        options={SERVICES}
        onChange={(next) => {
          if (next !== undefined) patch({ integration: next, credentials: {} });
        }}
        fieldPath=".integration"
      />
      <KeyValueField
        id="node-tool-credentials"
        label="Credentials"
        valueKind="secret"
        value={rows.view}
        onChange={(next) => patch({ credentials: rows.onChange(next) })}
        error={Object.keys(item.credentials ?? {}).length === 0 ? 'Add the credentials this integration needs' : undefined}
        help={`Suggested: ${[...spec.required, ...spec.optional].join(', ')}`}
        fieldPath=".credentials"
      />
    </>
  );
}
