/**
 * `FlowInputsEditor` — the `flowMeta.inputs` rows editor (C25): Name
 * (identifier, unique), Type (`FlowInputType` select), Required checkbox
 * and Description per row, plus Add / per-row remove. An empty list
 * deletes `inputs` from `flowMeta` so it stays out of the YAML.
 */
import type { ChangeEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { Field } from '../../../ui/Field';
import { Checkbox, Input, Select } from '../../../ui/controls';
import type { FlowInputType, FlowInputVariable } from '@linuxdevil/lousho/flows';
import './flow.css';

const INPUT_TYPES: FlowInputType[] = ['shortText', 'url', 'longText', 'number', 'json', 'fileBase64'];

/** One row's draft shape — mirrors `FlowInputVariable` with string fields. */
type Row = { name: string; type: FlowInputType; required: boolean; description: string };

/** `flowMeta.inputs` as editable rows (`undefined`/empty → `[]`). */
function rowsOf(inputs: unknown): Row[] {
  if (!Array.isArray(inputs)) return [];
  return inputs.map((raw) => {
    const item = (raw ?? {}) as Partial<FlowInputVariable>;
    return {
      name: typeof item.name === 'string' ? item.name : '',
      type: INPUT_TYPES.includes(item.type as FlowInputType) ? (item.type as FlowInputType) : 'shortText',
      required: item.required === true,
      description: typeof item.description === 'string' ? item.description : '',
    };
  });
}

/** Rows back to `FlowInputVariable[]`; blank names are dropped, empty descriptions omitted. */
function variablesOf(rows: Row[]): FlowInputVariable[] {
  return rows
    .filter((row) => row.name.trim() !== '')
    .map((row) => {
      const out: FlowInputVariable = { name: row.name.trim(), required: row.required, type: row.type };
      if (row.description.trim() !== '') out.description = row.description.trim();
      return out;
    });
}

/** Props for {@link FlowInputsEditor}. */
export interface FlowInputsEditorProps {
  /** `flowMeta.inputs` raw value. */
  inputs: unknown;
  /** Writes the new inputs array; an empty array deletes `inputs` from flowMeta. */
  onChange(inputs: FlowInputVariable[] | undefined): void;
  /** Base control id (`node-flow-<code>`). */
  id: string;
}

/** The flow inputs rows editor. */
export function FlowInputsEditor({ inputs, onChange, id }: FlowInputsEditorProps): JSX.Element {
  const rows = rowsOf(inputs);
  const names = rows.map((r) => r.name.trim()).filter((n) => n !== '');
  const duplicate = names.some((name, i) => names.indexOf(name) !== i);

  const update = (next: Row[]) => {
    const vars = variablesOf(next);
    onChange(vars.length === 0 ? undefined : vars);
  };
  const set = (index: number, patch: Partial<Row>) => update(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <Field
      id={id}
      label="Inputs"
      error={duplicate ? 'Each input needs a unique name' : undefined}
      hint="Values the flow needs before it starts."
    >
      <div className="kv-rows">
        {rows.map((row, index) => (
          <div key={index} className="flow-input-row">
            <Input
              id={index === 0 ? `${id}-name` : `${id}-name-${index}`}
              className="mono"
              value={row.name}
              placeholder="name"
              aria-label="Input name"
              onChange={(e: ChangeEvent<HTMLInputElement>) => set(index, { name: e.target.value })}
            />
            <Select
              id={`${id}-type-${index}`}
              aria-label="Input type"
              value={row.type}
              options={INPUT_TYPES.map((t) => ({ value: t, label: t }))}
              onChange={(e) => set(index, { type: e.target.value as FlowInputType })}
            />
            <Checkbox
              id={`${id}-required-${index}`}
              label="Required"
              checked={row.required}
              onChange={(e) => set(index, { required: e.target.checked })}
            />
            <Input
              id={`${id}-desc-${index}`}
              value={row.description}
              placeholder="Description"
              aria-label="Input description"
              onChange={(e: ChangeEvent<HTMLInputElement>) => set(index, { description: e.target.value })}
            />
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-sm kv-remove"
              aria-label={`Remove input ${row.name || index + 1}`}
              onClick={() => update(rows.filter((_, i) => i !== index))}
            >
              <X size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
        ))}
        <button type="button" className="btn btn-secondary btn-sm kv-add" onClick={() => update([...rows, { name: '', type: 'shortText', required: false, description: '' }])}>
          <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
          Add input
        </button>
      </div>
    </Field>
  );
}

