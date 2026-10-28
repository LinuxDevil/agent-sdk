/**
 * "New annotation queue": a name plus a rubric editor - one row per score
 * (name, optional description, optional min/max), at least one row. Success
 * posts `POST /api/v1/queues { name, rubric }` and refreshes the list; a 409
 * (taken name) or a 400 (say min above max) shows inline.
 */
import { useRef, useState, type FormEvent } from 'react';
import { ObserveApiError, observeClient } from '../../observe/observeClient';
import type { ObserveRubricEntry } from '../../observe/types';
import { useToast } from '../../ui/Toast';

/** One rubric row as typed: every field a string, `id` only keys the React row. */
interface RubricDraft {
  id: number;
  name: string;
  description: string;
  min: string;
  max: string;
}

type DraftField = Exclude<keyof RubricDraft, 'id'>;

const blankRow = (id: number): RubricDraft => ({ id, name: '', description: '', min: '', max: '' });

/** A typed bound as a number, `undefined` when blank. */
const bound = (text: string): number | undefined => (text.trim() === '' ? undefined : Number(text));

/** The rubric the daemon takes: trimmed names, blank description/min/max left out. */
function toRubric(rows: readonly RubricDraft[]): ObserveRubricEntry[] {
  return rows.map((row) => {
    const entry: ObserveRubricEntry = { name: row.name.trim() };
    const description = row.description.trim();
    if (description) entry.description = description;
    const min = bound(row.min);
    const max = bound(row.max);
    if (min !== undefined) entry.min = min;
    if (max !== undefined) entry.max = max;
    return entry;
  });
}

/** The create failure shown inline: a 409 is a taken name, anything else its message. */
const createError = (error: unknown): string =>
  error instanceof ObserveApiError && error.status === 409
    ? 'Could not create: a queue with that name exists.'
    : `Could not create the queue: ${(error as Error).message}`;

const FIELDS: { field: DraftField; label: string; type: 'text' | 'number'; wide?: boolean }[] = [
  { field: 'name', label: 'Score name', type: 'text' },
  { field: 'description', label: 'Description (optional)', type: 'text', wide: true },
  { field: 'min', label: 'Min', type: 'number' },
  { field: 'max', label: 'Max', type: 'number' },
];

function RubricRow({
  row,
  index,
  onChange,
  onRemove,
  canRemove,
}: {
  row: RubricDraft;
  index: number;
  onChange: (field: DraftField, value: string) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  return (
    <div className="queues-rubric-row">
      {FIELDS.map(({ field, label, type, wide }) => (
        <label key={field} className={`datasets-field${wide ? ' datasets-field-wide' : ' queues-field-narrow'}`}>
          <span>{label}</span>
          <input
            name={`rubric-${field}-${index}`}
            type={type}
            step={type === 'number' ? 'any' : undefined}
            value={row[field]}
            onChange={(e) => onChange(field, e.target.value)}
          />
        </label>
      ))}
      <button
        type="button"
        className="btn btn-ghost"
        aria-label={`Remove rubric row ${index + 1}`}
        disabled={!canRemove}
        onClick={onRemove}
      >
        Remove
      </button>
    </div>
  );
}

/** The rubric rows' state: edit, add, remove (never below one row). */
function useRubricRows() {
  const nextId = useRef(1);
  const [rows, setRows] = useState<RubricDraft[]>([blankRow(0)]);
  return {
    rows,
    update: (id: number, field: DraftField, value: string) =>
      setRows((all) => all.map((row) => (row.id === id ? { ...row, [field]: value } : row))),
    add: () => setRows((all) => [...all, blankRow(nextId.current++)]),
    remove: (id: number) => setRows((all) => (all.length > 1 ? all.filter((row) => row.id !== id) : all)),
    reset: () => setRows([blankRow(nextId.current++)]),
  };
}

/** The "New annotation queue" form; `onCreated` runs after a successful create. */
export function NewQueueForm({ onCreated }: { onCreated: () => void }) {
  const toast = useToast();
  const rubric = useRubricRows();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const ready = name.trim() !== '' && rubric.rows.every((row) => row.name.trim() !== '');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    const target = name.trim();
    setSaving(true);
    setError(undefined);
    try {
      await observeClient.createQueue({ name: target, rubric: toRubric(rubric.rows) });
      toast.show({ tone: 'success', message: `Created queue ${target}.` });
      setName('');
      rubric.reset();
      onCreated();
    } catch (failure) {
      setError(createError(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="datasets-new" aria-label="New annotation queue" onSubmit={(e) => void submit(e)}>
      <h3 className="datasets-section-title">New annotation queue</h3>
      <label className="datasets-field">
        <span>Name</span>
        <input name="queue-name" type="text" value={name} placeholder="e.g. support-review" onChange={(e) => setName(e.target.value)} />
      </label>
      <fieldset className="queues-rubric">
        <legend>Rubric (one row per score)</legend>
        {rubric.rows.map((row, index) => (
          <RubricRow
            key={row.id}
            row={row}
            index={index}
            onChange={(field, value) => rubric.update(row.id, field, value)}
            onRemove={() => rubric.remove(row.id)}
            canRemove={rubric.rows.length > 1}
          />
        ))}
      </fieldset>
      <div className="queues-form-actions">
        <button type="button" className="btn btn-ghost" onClick={rubric.add}>
          Add rubric row
        </button>
        <button type="submit" className="btn" disabled={saving || !ready}>
          Create queue
        </button>
      </div>
      {error && (
        <p className="datasets-form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
