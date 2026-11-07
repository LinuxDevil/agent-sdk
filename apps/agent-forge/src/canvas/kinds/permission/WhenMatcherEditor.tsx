/**
 * `WhenMatcherEditor` edits a permission rule's `item.when` record as one
 * row per condition: an argument-path input, an operator select and an
 * operand input, plus a labelled remove button and an 'Add condition'
 * button. Rows are a local draft so an unparseable operand can be shown
 * with a per-row error instead of being collapsed by the record; only a
 * fully valid row set is emitted (`undefined` for an empty map), like
 * `KeyValueField`.
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { Field } from '../../../ui/Field';
import { Input, Select, type SelectOption } from '../../../ui/controls';
import { fromRows, toRows, type WhenMap, type WhenOperator, type WhenRow } from './whenRows';
import './permission.css';

/** Props for {@link WhenMatcherEditor}. */
export interface WhenMatcherEditorProps {
  /** Control id (`node-<kind>-<field>`); rows take `<id>-arg-<n>` / `<id>-op-<n>` / `<id>-value-<n>`. */
  id: string;
  /** Field label text. */
  label: string;
  value: WhenMap | undefined;
  onChange(value: WhenMap | undefined): void;
  /** Muted help under the control. */
  help?: string;
}

/** The operator select's options, in the ticket's order. */
const OPERATOR_OPTIONS: SelectOption[] = [
  { value: 'pattern', label: 'matches pattern' },
  { value: 'eq', label: 'is' },
  { value: 'ne', label: 'is not' },
  { value: 'lt', label: 'less than' },
  { value: 'lte', label: 'at most' },
  { value: 'gt', label: 'more than' },
  { value: 'gte', label: 'at least' },
  { value: 'matches', label: 'matches regular expression' },
];

/** The condition-list control the permission Inspector's `when` field uses. */
export function WhenMatcherEditor({
  id,
  label,
  value,
  onChange,
  help,
}: WhenMatcherEditorProps): JSX.Element {
  const [rows, setRows] = useState<WhenRow[]>(() => toRows(value));
  // The last record this field emitted, so an external change can be told
  // apart from the echo of our own onChange (which must not clobber an
  // in-progress invalid row).
  const emitted = useRef<WhenMap | undefined>(value);
  useEffect(() => {
    if (value === emitted.current) return;
    setRows(toRows(value));
  }, [value]);

  const errors = fromRows(rows).errors;

  /** Emits `nextRows` when every row is valid; the draft always updates either way. */
  const update = (nextRows: WhenRow[]) => {
    setRows(nextRows);
    const parsed = fromRows(nextRows);
    if (parsed.errors.some((message) => message !== undefined)) return;
    emitted.current = parsed.when;
    onChange(parsed.when);
  };

  const setRow = (index: number, patch: Partial<WhenRow>) => {
    const next = rows.slice();
    next[index] = { ...next[index], ...patch };
    update(next);
  };
  const remove = (index: number) => {
    update([...rows.slice(0, index), ...rows.slice(index + 1)]);
  };
  const add = () => {
    update([...rows, { arg: '', op: 'eq', value: '' }]);
  };

  return (
    <Field id={id} label={label} hint={help}>
      <div className="when-rows">
        {rows.map((row, index) => (
          <div key={index} className="when-row-wrap">
            <div className="when-row">
              <Input
                id={`${id}-arg-${index}`}
                value={row.arg}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setRow(index, { arg: event.target.value })
                }
                placeholder="Argument"
                aria-label={`Condition ${index + 1} argument`}
              />
              <Select
                id={`${id}-op-${index}`}
                options={OPERATOR_OPTIONS}
                value={row.op}
                onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                  setRow(index, { op: event.target.value as WhenOperator })
                }
                aria-label={`Condition ${index + 1} operator`}
              />
              <Input
                id={`${id}-value-${index}`}
                value={row.value}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setRow(index, { value: event.target.value })
                }
                placeholder="Value"
                aria-label={`Condition ${index + 1} value`}
              />
              <button
                type="button"
                className="btn btn-ghost btn-icon btn-sm when-remove"
                aria-label={`Remove condition ${row.arg}`}
                onClick={() => remove(index)}
              >
                <X size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>
            {errors[index] !== undefined && <p className="hint field-error">{errors[index]}</p>}
          </div>
        ))}
        <button
          type="button"
          id={`${id}-add`}
          className="btn btn-secondary btn-sm when-add"
          onClick={add}
        >
          <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
          Add condition
        </button>
      </div>
    </Field>
  );
}
