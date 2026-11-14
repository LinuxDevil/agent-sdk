/**
 * The memory Inspector's Scope section: the three `MemoryScopeSpec` shapes
 * as a choice — one shared memory (`global`), one per session (`session`),
 * one per value of a run's `metadata[key]` — plus the metadata-key input
 * the third shape needs. A function `scope` is code, not data, so the
 * choice covers every serializable form.
 */
import type { ChangeEvent } from 'react';
import { Field } from '../../../ui/Field';
import { Input } from '../../../ui/controls';
import { ChoiceField } from '../../fields/ChoiceField';
import type { MemoryScopeSpec, MemorySpec } from '../../../graph/v2/specTypes';
import type { KindFieldsProps } from '../index';

type Patch = KindFieldsProps<'memory'>['patch'];

/** The value the Scope choice shows. */
type ScopeChoice = 'global' | 'session' | 'metadata';

const SCOPE_OPTIONS: { value: ScopeChoice; label: string }[] = [
  { value: 'global', label: 'Shared by everyone' },
  { value: 'session', label: 'One per session' },
  { value: 'metadata', label: 'One per value of a metadata key' },
];

/** `scope`'s choice value: the `{ metadataKey }` object is the third option. */
function choiceOf(scope: MemoryScopeSpec): ScopeChoice {
  if (typeof scope === 'object') return 'metadata';
  return scope === 'global' ? 'global' : 'session';
}

/** Trim-empty is empty: `undefined`, non-strings and whitespace-only values all count as missing. */
function blank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

/** The Scope choice plus the conditional Metadata key input described above. */
export function ScopeField({ item, patch }: { item: MemorySpec; patch: Patch }): JSX.Element {
  const choice = choiceOf(item.scope);
  const onScope = (next: ScopeChoice | undefined) => {
    if (next === undefined || next === choice) return;
    patch({ scope: next === 'metadata' ? { metadataKey: '' } : next });
  };
  return (
    <>
      <ChoiceField
        id="node-memory-scope"
        label="Scope"
        value={choice}
        options={SCOPE_OPTIONS}
        onChange={onScope}
      />
      {choice === 'metadata' && typeof item.scope === 'object' && (
        <Field
          id="node-memory-metadata-key"
          label="Metadata key"
          required
          error={blank(item.scope.metadataKey) ? 'Enter the metadata key, e.g. userId' : undefined}
          hint="Each run's metadata value picks the slot."
        >
          <Input
            value={item.scope.metadataKey}
            placeholder="userId"
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              patch({ scope: { metadataKey: event.target.value } })
            }
          />
        </Field>
      )}
    </>
  );
}
