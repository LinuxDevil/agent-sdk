/**
 * The `memory` kind's Inspector body: the slot name (the
 * `remember_<name>`/`recall_<name>` tools are named after it) and
 * description, the Scope and Storage sub-forms (`ScopeField`,
 * `StorageFields`), the last-message recall and its item limit, the two
 * "The model can" checkboxes over `expose`, and the optional item schema +
 * item key. Everything patches `data.item` — the fields sit flat on the
 * `MemorySpec`, so no `replace` is needed.
 *
 * Field names follow the SDK's `MemorySpec` (`recall.maxItems`,
 * `expose.remember`/`recall`), so "The model can read" is `expose.recall`
 * and "The model can write" is `expose.remember`; a checkbox shows checked
 * when its key is absent because the SDK default is on.
 */
import type { ChangeEvent } from 'react';
import { Field } from '../../../ui/Field';
import { Checkbox, Input, Switch, Textarea } from '../../../ui/controls';
import { MEMORY_NAME_PATTERN } from '../../../graph/v2/kinds/memory';
import type { MemorySpec } from '../../../graph/v2/specTypes';
import { JsonField } from '../../fields/JsonField';
import { OptionalNumberField } from '../../fields/OptionalNumberField';
import { ScopeField } from './ScopeField';
import { StorageFields } from './StorageFields';
import type { KindFieldsProps } from '../index';

type Patch = KindFieldsProps<'memory'>['patch'];

const NAME_ERROR = 'Use letters, digits, dash or underscore (max 55)';
const SCHEMA_ERROR = 'Use a JSON Schema object';

/** `check` for the item-schema JsonField: a JSON Schema is an object, not a scalar or array. */
function objectSchemaOk(value: unknown): string | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? undefined : SCHEMA_ERROR;
}

/** The "Recall from the last message" switch plus its item limit. */
function RecallFields({ item, patch }: { item: MemorySpec; patch: Patch }): JSX.Element {
  const recallOn = item.recall?.query === 'last-input';
  const onLimit = (maxItems: number | undefined) => {
    const recall = { ...item.recall, query: 'last-input' as const };
    if (maxItems === undefined) delete recall.maxItems;
    else recall.maxItems = maxItems;
    patch({ recall });
  };
  return (
    <>
      <Field
        id="node-memory-recall"
        label="Recall from the last message"
        inline
        hint="Injects matching items before the first model call."
      >
        <Switch
          checked={recallOn}
          onChange={(on) => patch({ recall: on ? { ...item.recall, query: 'last-input' } : undefined })}
        />
      </Field>
      {recallOn && (
        <OptionalNumberField
          id="node-memory-recall-limit"
          label="Items to recall"
          value={item.recall?.maxItems}
          onChange={onLimit}
          integer
          min={1}
          max={50}
        />
      )}
    </>
  );
}

/**
 * The `expose` checkboxes. The SDK default is on for `remember`/`recall`,
 * so an absent key shows checked; unchecking writes `false`, re-checking a
 * `false` key deletes it, and `expose` itself is deleted when it becomes `{}`.
 */
function ExposeFields({ item, patch }: { item: MemorySpec; patch: Patch }): JSX.Element {
  const set = (key: 'remember' | 'recall', on: boolean) => {
    const next = { ...item.expose };
    if (on) delete next[key];
    else next[key] = false;
    patch({ expose: Object.keys(next).length === 0 ? undefined : next });
  };
  return (
    <>
      <Checkbox
        id="node-memory-read"
        label="The model can read"
        checked={item.expose?.recall ?? true}
        onChange={(event: ChangeEvent<HTMLInputElement>) => set('recall', event.target.checked)}
      />
      <Checkbox
        id="node-memory-write"
        label="The model can write"
        checked={item.expose?.remember ?? true}
        onChange={(event: ChangeEvent<HTMLInputElement>) => set('remember', event.target.checked)}
      />
    </>
  );
}

/** The memory Inspector described above. */
export function MemoryFields({ node, patch }: KindFieldsProps<'memory'>): JSX.Element {
  const { item } = node.data;
  const itemKey = Array.isArray(item.itemKey) ? item.itemKey.join(', ') : (item.itemKey ?? '');
  return (
    <>
      <Field
        id="node-memory-name"
        label="Name"
        required
        error={MEMORY_NAME_PATTERN.test(item.name) ? undefined : NAME_ERROR}
        hint="Tools are named remember_<name> and recall_<name>."
      >
        <Input
          value={item.name}
          onChange={(event: ChangeEvent<HTMLInputElement>) => patch({ name: event.target.value })}
        />
      </Field>
      <Field id="node-memory-description" label="Description" hint="Tells the model what belongs here.">
        <Textarea
          rows={2}
          value={item.description ?? ''}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
            patch({ description: event.target.value === '' ? undefined : event.target.value })
          }
        />
      </Field>
      <ScopeField item={item} patch={patch} />
      <StorageFields item={item} patch={patch} />
      <RecallFields item={item} patch={patch} />
      <ExposeFields item={item} patch={patch} />
      <JsonField
        id="node-memory-schema"
        label="Item schema"
        rows={6}
        value={item.itemJsonSchema}
        onChange={(itemJsonSchema) => patch({ itemJsonSchema })}
        check={objectSchemaOk}
        help="Optional. Stores structured items."
      />
      <Field
        id="node-memory-item-key"
        label="Item key"
        hint="Field that identifies an item, so saving it again updates it."
      >
        <Input
          value={itemKey}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            patch({ itemKey: event.target.value === '' ? undefined : event.target.value })
          }
        />
      </Field>
    </>
  );
}
