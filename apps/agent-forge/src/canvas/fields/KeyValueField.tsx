/**
 * `KeyValueField` edits a `Record<string, string | SecretRef>` spec value
 * as editable rows (key input + text or SecretRef value + remove button)
 * plus an 'Add' button. Rows are a local draft so duplicate keys can be
 * shown with an error instead of being collapsed by the record; only a
 * valid row set is emitted (`undefined` for an empty map), and insertion
 * order is preserved.
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { Field } from '../../ui/Field';
import { Input } from '../../ui/controls';
import { SecretRefField } from './SecretRefField';
import type { SecretRef } from '../../../shared/wireTypes';
import './fields.css';

type RowValue = string | SecretRef;

interface KvRow {
  key: string;
  value: RowValue;
}

/** Props for {@link KeyValueField}. */
export interface KeyValueFieldProps {
  /** Control id (`node-<kind>-<field>`); rows take `<id>-key-<n>` / `<id>-value-<n>`. */
  id: string;
  /** Field label text. */
  label: string;
  value: Record<string, RowValue> | undefined;
  onChange(value: Record<string, RowValue> | undefined): void;
  /** `'text'` gives every row a plain input; `'secret'` a {@link SecretRefField} with `allowPlain`. */
  valueKind: 'text' | 'secret';
  /** Every non-empty key must match (env-name maps pass `^[A-Z_][A-Z0-9_]*$`). */
  keyPattern?: RegExp;
  /** Muted help under the control. */
  help?: string;
}

const DUPLICATE_KEYS_ERROR = 'Each name must be unique';
const KEY_PATTERN_ERROR = 'Use capitals, digits and underscores';

/** `value`'s entries as mutable draft rows, in insertion order. */
function rowsOf(value: Record<string, RowValue> | undefined): KvRow[] {
  return Object.entries(value ?? {}).map(([key, rowValue]) => ({ key, value: rowValue }));
}

/** The first problem with `rows` ('Each name must be unique', then the key pattern), or `undefined`. */
function validate(rows: KvRow[], keyPattern: RegExp | undefined): string | undefined {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.key)) return DUPLICATE_KEYS_ERROR;
    seen.add(row.key);
  }
  if (keyPattern !== undefined && rows.some((row) => row.key !== '' && !keyPattern.test(row.key))) {
    return KEY_PATTERN_ERROR;
  }
  return undefined;
}

/** `rows` as a record, in row order (valid rows only - callers validate first). */
function mapOf(rows: KvRow[]): Record<string, RowValue> {
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

/**
 * The name/value-map control `env`, `headers`, `credentials`,
 * `instructionsByFamily` and channel `secrets` use across the node
 * inspectors.
 */
export function KeyValueField({
  id,
  label,
  value,
  onChange,
  valueKind,
  keyPattern,
  help,
}: KeyValueFieldProps): JSX.Element {
  const [rows, setRows] = useState<KvRow[]>(() => rowsOf(value));
  // The last record this field emitted, so an external change can be told
  // apart from the echo of our own onChange (which must not clobber an
  // in-progress invalid row).
  const emitted = useRef<Record<string, RowValue> | undefined>(value);
  useEffect(() => {
    if (value === emitted.current) return;
    setRows(rowsOf(value));
  }, [value]);

  const problem = validate(rows, keyPattern);

  /** Emits `nextRows` when they are valid; the draft always updates either way. */
  const update = (nextRows: KvRow[]) => {
    setRows(nextRows);
    if (validate(nextRows, keyPattern) !== undefined) return;
    const next = nextRows.length === 0 ? undefined : mapOf(nextRows);
    emitted.current = next;
    onChange(next);
  };

  const setKey = (index: number, key: string) => {
    update(rows.map((row, i) => (i === index ? { ...row, key } : row)));
  };
  const setValue = (index: number, rowValue: RowValue) => {
    update(rows.map((row, i) => (i === index ? { ...row, value: rowValue } : row)));
  };
  const remove = (index: number) => {
    update(rows.filter((_, i) => i !== index));
  };
  const add = () => {
    update([...rows, { key: '', value: '' }]);
  };

  return (
    <Field id={id} label={label} error={problem} hint={help}>
      <div className="kv-rows">
        {rows.map((row, index) => (
          <div key={index} className="kv-row">
            <Input
              id={index === 0 ? id : `${id}-key-${index}`}
              value={row.key}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setKey(index, event.target.value)}
              placeholder="Name"
            />
            {valueKind === 'secret' ? (
              <SecretRefField
                id={`${id}-value-${index}`}
                label="Value"
                value={row.value}
                onChange={(next) => setValue(index, next ?? '')}
                allowPlain
              />
            ) : (
              <Input
                id={`${id}-value-${index}`}
                value={typeof row.value === 'string' ? row.value : ''}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setValue(index, event.target.value)}
                placeholder="Value"
              />
            )}
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-sm kv-remove"
              aria-label={`Remove ${row.key || 'entry'}`}
              onClick={() => remove(index)}
            >
              <X size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
        ))}
        <button
          type="button"
          id={rows.length === 0 ? id : `${id}-add`}
          className="btn btn-secondary btn-sm kv-add"
          onClick={add}
        >
          <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
          Add
        </button>
      </div>
    </Field>
  );
}
