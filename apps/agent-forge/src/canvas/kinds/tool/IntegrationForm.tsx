/**
 * The `{ integration }` form of the tool Inspector: the service picker
 * (GitHub, Jira, Slack or email) and the credentials map, edited as
 * SecretRef-or-string rows. An empty credentials map shows the service's
 * suggested keys as blank rows — keys only, values are never prefilled —
 * and switching service resets the map so keys of the old service are
 * not carried over.
 */
import { useMemo } from 'react';
import { INTEGRATION_CREDENTIALS, type IntegrationName, type SecretRef } from '../../../graph/v2/specTypes';
import { ChoiceField } from '../../fields/ChoiceField';
import { KeyValueField } from '../../fields/KeyValueField';
import type { ToolSubFormProps } from './BuiltinForm';

const SERVICES: { value: IntegrationName; label: string }[] = [
  { value: 'github', label: 'GitHub' },
  { value: 'jira', label: 'Jira' },
  { value: 'slack', label: 'Slack' },
  { value: 'email', label: 'Email' },
];

/** The suggested credential rows per service: the required keys with empty values (keys only, never values). */
const BLANK_CREDENTIALS = Object.fromEntries(
  SERVICES.map(({ value }) => [
    value,
    Object.fromEntries(INTEGRATION_CREDENTIALS[value].required.map((key) => [key, ''])),
  ]),
) as Record<IntegrationName, Record<string, string | SecretRef>>;

/** The `credentials` map `KeyValueField` shows: real entries plus a blank row per missing suggested key. */
function displayCredentials(
  service: IntegrationName,
  credentials: Record<string, string | SecretRef>
): Record<string, string | SecretRef> {
  return { ...BLANK_CREDENTIALS[service], ...credentials };
}

/** The `{ integration }` sub-form described above. */
export function IntegrationForm({ item, patch }: ToolSubFormProps<'integration'>): JSX.Element {
  const service = item.integration;
  const credentials = item.credentials ?? {};
  const value = useMemo(
    () => displayCredentials(service, credentials),
    [service, credentials]
  );
  const spec = INTEGRATION_CREDENTIALS[service];
  const suggested = [...spec.required, ...spec.optional].join(', ');
  return (
    <>
      <ChoiceField
        id="node-tool-service"
        label="Service"
        value={service}
        options={SERVICES}
        onChange={(next) => {
          if (next !== undefined) patch({ integration: next, credentials: {} });
        }}
      />
      <KeyValueField
        id="node-tool-credentials"
        label="Credentials"
        valueKind="secret"
        value={value}
        onChange={(next) => patch({ credentials: next ?? {} })}
        error={Object.keys(credentials).length === 0 ? 'Add the credentials this integration needs' : undefined}
        help={`Suggested: ${suggested}`}
      />
    </>
  );
}
