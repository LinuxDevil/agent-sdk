/**
 * The `{ registry }` form of the tool Inspector: the registry item name
 * (installed by `lousho add`) and an optional version pin.
 */
import type { ChangeEvent } from 'react';
import { Field } from '../../../ui/Field';
import { Input } from '../../../ui/controls';
import type { ToolSubFormProps } from './BuiltinForm';

/** The registry name rule (the spec schema's `^[a-z0-9][a-z0-9-]{0,63}$`). */
const REGISTRY_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A loose semver check for the optional version pin. */
const VERSION_PATTERN = /^\d+\.\d+\.\d+/;

/** The Name error: required, then the pattern. */
function nameError(name: string): string | undefined {
  if (name === '') return 'Enter the registry item name';
  return REGISTRY_NAME_PATTERN.test(name) ? undefined : 'Use lower-case letters, digits and dashes';
}

/** The Version error: optional, but semver-ish when set. */
function versionError(version: string): string | undefined {
  return version === '' || VERSION_PATTERN.test(version) ? undefined : 'Use a version like 1.2.0';
}

/** The `{ registry }` sub-form described above. */
export function RegistryForm({ item, patch }: ToolSubFormProps<'registry'>): JSX.Element {
  const name = item.registry;
  const version = item.version ?? '';
  return (
    <>
      <Field
        id="node-tool-registry"
        label="Name"
        required
        error={nameError(name)}
        hint="Installed with lousho add."
        fieldPath=".registry"
      >
        <Input
          value={name}
          onChange={(event: ChangeEvent<HTMLInputElement>) => patch({ registry: event.target.value })}
        />
      </Field>
      <Field id="node-tool-version" label="Version" error={versionError(version)} fieldPath=".version">
        <Input
          value={version}
          placeholder="1.2.0"
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            patch({ version: event.target.value === '' ? undefined : event.target.value })
          }
        />
      </Field>
    </>
  );
}
