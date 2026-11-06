/**
 * The `{ integration }` form of the tool Inspector: the service picker
 * (GitHub, Jira, Slack or email) and the credentials map, edited as
 * SecretRef-or-string rows. An empty credentials map shows the service's
 * suggested keys as blank rows — keys only, values are never prefilled —
 * and switching service resets the map so keys of the old service are
 * not carried over. Blank rows are display-only: a credential entry
 * lands in the spec only once its value is set, and a row the user
 * removes stays removed.
 */
import { useRef } from 'react';
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

/**
 * The `credentials` map `KeyValueField` opens with: the service's blank
 * suggestion rows while the map is empty, the map itself otherwise —
 * prefilling only on empty keeps a row the user removed from coming back.
 */
function displayCredentials(
  service: IntegrationName,
  credentials: Record<string, string | SecretRef>
): Record<string, string | SecretRef> {
  return Object.keys(credentials).length === 0 ? { ...BLANK_CREDENTIALS[service] } : credentials;
}

/** `map` without its blank-valued rows — suggestion rows are display-only and never reach the spec. */
function nonBlank(map: Record<string, string | SecretRef> | undefined): Record<string, string | SecretRef> {
  return Object.fromEntries(Object.entries(map ?? {}).filter(([, value]) => value !== ''));
}

/** The `{ integration }` sub-form described above. */
export function IntegrationForm({ item, patch }: ToolSubFormProps<'integration'>): JSX.Element {
  const service = item.integration;
  const credentials = item.credentials ?? {};
  const spec = INTEGRATION_CREDENTIALS[service];
  const suggested = [...spec.required, ...spec.optional].join(', ');
  // `emitted` tracks the credentials object this form last wrote and `view`
  // the record the rows show — our emit verbatim, blank suggestion rows
  // included, so typing keeps every row (KeyValueField resyncs its draft
  // rows whenever `value` is not its own echo) and a removed row stays
  // removed. `view` is rebuilt from the spec only when `item.credentials`
  // is not the object we wrote — a service switch, undo or an outside edit.
  const emitted = useRef<Record<string, string | SecretRef> | undefined>(undefined);
  const view = useRef<Record<string, string | SecretRef>>({});
  if (emitted.current !== item.credentials) {
    emitted.current = item.credentials;
    view.current = displayCredentials(service, credentials);
  }
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
        value={view.current}
        onChange={(next) => {
          view.current = next ?? {};
          emitted.current = nonBlank(next);
          patch({ credentials: emitted.current });
        }}
        error={Object.keys(credentials).length === 0 ? 'Add the credentials this integration needs' : undefined}
        help={`Suggested: ${suggested}`}
      />
    </>
  );
}
