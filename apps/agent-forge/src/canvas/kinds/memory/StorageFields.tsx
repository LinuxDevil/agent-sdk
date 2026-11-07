/**
 * The memory Inspector's Storage section: the provider choice swaps the
 * whole `item.provider` (`in-memory`, `file`, `sqlite-vector` — the three
 * serializable `MemoryProviderSpec` forms), then the fields that form
 * needs: the folder for `file`, the database path, embedding model and
 * minimum score for `sqlite-vector`.
 */
import type { ChangeEvent } from 'react';
import { Field } from '../../../ui/Field';
import { Input } from '../../../ui/controls';
import { ChoiceField } from '../../fields/ChoiceField';
import { OptionalNumberField } from '../../fields/OptionalNumberField';
import type { MemoryProviderSpec, MemorySpec } from '../../../graph/v2/specTypes';
import type { KindFieldsProps } from '../index';

type Patch = KindFieldsProps<'memory'>['patch'];

type StorageChoice = MemoryProviderSpec['type'];

const STORAGE_OPTIONS: { value: StorageChoice; label: string }[] = [
  { value: 'in-memory', label: 'In memory' },
  { value: 'file', label: 'Files' },
  { value: 'sqlite-vector', label: 'SQLite with vector search' },
];

/** The empty provider each Storage choice seeds (fresh object per call — node data is never shared). */
function emptyProvider(type: StorageChoice): MemoryProviderSpec {
  if (type === 'file') return { type: 'file', dir: '' };
  if (type === 'sqlite-vector') return { type: 'sqlite-vector', embedder: '' };
  return { type: 'in-memory' };
}

/** Trim-empty is empty: `undefined`, non-strings and whitespace-only values all count as missing. */
function blank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

/**
 * `provider` merged with `part`; `undefined` part values delete the key so
 * optional keys (`path`, `minScore`) stay out of the emitted spec.
 */
function providerPatch(provider: MemoryProviderSpec, part: Record<string, unknown>): MemoryProviderSpec {
  const next = { ...provider, ...part } as Record<string, unknown>;
  for (const key of Object.keys(next)) {
    if (next[key] === undefined) delete next[key];
  }
  return next as unknown as MemoryProviderSpec;
}

/** The `{ type: 'file', dir }` sub-form: a folder relative to the agent folder. */
function FileForm({ provider, set }: { provider: Extract<MemoryProviderSpec, { type: 'file' }>; set: (part: Record<string, unknown>) => void }): JSX.Element {
  return (
    <Field
      id="node-memory-dir"
      label="Folder"
      required
      error={blank(provider.dir) ? 'Enter the folder for memory files' : undefined}
    >
      <Input
        value={provider.dir}
        placeholder="memory"
        onChange={(event: ChangeEvent<HTMLInputElement>) => set({ dir: event.target.value })}
      />
    </Field>
  );
}

/** The `{ type: 'sqlite-vector' }` sub-form: database file, embedder id and minimum score. */
function VectorForm({ provider, set }: { provider: Extract<MemoryProviderSpec, { type: 'sqlite-vector' }>; set: (part: Record<string, unknown>) => void }): JSX.Element {
  return (
    <>
      <Field id="node-memory-path" label="Database file" hint="Defaults to the Studio data folder.">
        <Input
          value={provider.path ?? ''}
          placeholder=".lousho/memory.db"
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            set({ path: event.target.value === '' ? undefined : event.target.value })
          }
        />
      </Field>
      <Field
        id="node-memory-embedder"
        label="Embedding model"
        required
        error={blank(provider.embedder) ? 'Pick an embedding model' : undefined}
      >
        <Input
          value={provider.embedder}
          placeholder="openai/text-embedding-3-small"
          onChange={(event: ChangeEvent<HTMLInputElement>) => set({ embedder: event.target.value })}
        />
      </Field>
      <OptionalNumberField
        id="node-memory-minscore"
        label="Minimum score"
        value={provider.minScore}
        onChange={(minScore) => set({ minScore })}
        min={0}
        max={1}
        step={0.05}
        help="Lower recalls more, less related items."
      />
    </>
  );
}

/** The Storage choice plus the provider form described above. */
export function StorageFields({ item, patch }: { item: MemorySpec; patch: Patch }): JSX.Element {
  const { provider } = item;
  const set = (part: Record<string, unknown>) => patch({ provider: providerPatch(provider, part) });
  const onStorage = (next: StorageChoice | undefined) => {
    if (next === undefined || next === provider.type) return;
    patch({ provider: emptyProvider(next) });
  };
  return (
    <>
      <ChoiceField
        id="node-memory-storage"
        label="Storage"
        value={provider.type}
        options={STORAGE_OPTIONS}
        onChange={onStorage}
      />
      {provider.type === 'file' && <FileForm provider={provider} set={set} />}
      {provider.type === 'sqlite-vector' && <VectorForm provider={provider} set={set} />}
    </>
  );
}
