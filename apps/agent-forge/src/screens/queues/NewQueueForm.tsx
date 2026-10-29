/**
 * "New annotation queue", a card opened from the list header: a name plus a
 * rubric editor - one bordered row per score (name, optional description,
 * optional min/max), at least one row. Success posts
 * `POST /api/v1/queues { name, rubric }` and hands back to the list (which
 * closes the card and refreshes); a 409 (taken name) or a 400 (say min above
 * max) shows inline.
 */
import { useRef, useState, type FormEvent } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { ObserveApiError, observeClient } from '../../observe/observeClient';
import type { ObserveRubricEntry } from '../../observe/types';
import { useToast } from '../../ui/Toast';

/** The form's element id, for the header button's `aria-controls`. */
export const NEW_QUEUE_FORM_ID = 'new-queue-form';

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

const FIELDS: { field: DraftField; label: string; type: 'text' | 'number'; size: 'name' | 'wide' | 'bound'; placeholder?: string }[] = [
  { field: 'name', label: 'Score name', type: 'text', size: 'name', placeholder: 'e.g. helpfulness' },
  { field: 'description', label: 'Description (optional)', type: 'text', size: 'wide', placeholder: 'What the reviewer judges' },
  { field: 'min', label: 'Min', type: 'number', size: 'bound' },
  { field: 'max', label: 'Max', type: 'number', size: 'bound' },
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
    <li className="qu-rubric-row">
      <span className="qu-rubric-index" aria-hidden="true">
        {index + 1}
      </span>
      <div className="qu-rubric-fields">
        {FIELDS.map(({ field, label, type, size, placeholder }) => (
          <label key={field} className={`ds-field qu-rubric-${size}`}>
            <span className="ds-field-label">{label}</span>
            <input
              className="input"
              name={`rubric-${field}-${index}`}
              type={type}
              step={type === 'number' ? 'any' : undefined}
              value={row[field]}
              placeholder={placeholder}
              onChange={(e) => onChange(field, e.target.value)}
            />
          </label>
        ))}
      </div>
      <button
        type="button"
        className="btn btn-ghost btn-icon btn-sm qu-rubric-remove"
        aria-label={`Remove rubric row ${index + 1}`}
        title="Remove"
        disabled={!canRemove}
        onClick={onRemove}
      >
        <Trash2 aria-hidden="true" />
      </button>
    </li>
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
  };
}

/** The "New annotation queue" card; `onCreated` runs after a successful create, `onCancel` closes it. */
export function NewQueueForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
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
      onCreated();
    } catch (failure) {
      setError(createError(failure));
      setSaving(false);
    }
  };

  return (
    <form id={NEW_QUEUE_FORM_ID} className="card qu-new" aria-label="New annotation queue" onSubmit={(e) => void submit(e)}>
      <div className="qu-new-head">
        <div className="card-heading">
          <h3 className="card-title">New annotation queue</h3>
          <p className="card-description">Name the queue and the scores a reviewer gives each trace.</p>
        </div>
        <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Close new queue" onClick={onCancel}>
          <X aria-hidden="true" />
        </button>
      </div>
      <label className="ds-field qu-new-name">
        <span className="ds-field-label">Name</span>
        <input
          className="input"
          name="queue-name"
          type="text"
          value={name}
          placeholder="e.g. support-review"
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <fieldset className="qu-rubric">
        <legend className="qu-legend overline">Rubric (one row per score)</legend>
        <ol className="qu-rubric-rows">
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
        </ol>
        <button type="button" className="btn btn-ghost btn-sm qu-rubric-add" onClick={rubric.add}>
          <Plus aria-hidden="true" />
          Add rubric row
        </button>
      </fieldset>
      {error && (
        <p className="datasets-form-error" role="alert">
          {error}
        </p>
      )}
      <div className="qu-new-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={saving || !ready}>
          Create queue
        </button>
      </div>
    </form>
  );
}
