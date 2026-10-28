/**
 * "Add to dataset" on the trace header: a button opening a small dialog that
 * lists the datasets (or takes a new name), then posts
 * `POST /api/v1/datasets/:name/examples { from_trace_id }` - the daemon
 * copies the trace root's input/output in as the example. A new name is
 * created first (`POST /api/v1/datasets`; a 409 means it already exists, so
 * the add goes ahead). The outcome is a toast; success links to the dataset.
 * Escape or Cancel closes the dialog, and focus returns to the button.
 */
import '../datasets/datasets.css';
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { navigate } from '../../router/router';
import { useDatasets } from '../../observe/useObserve';
import { ObserveApiError, observeClient } from '../../observe/observeClient';
import { useToast } from '../../ui/Toast';
import { datasetPath } from '../datasets/datasetsUrl';

/** The dataset picker lists at most this many (the daemon's max page). */
const PICKER_LIMIT = 1000;
/** The select value meaning "a new dataset, named below". */
const NEW = '';

/** Create `name` unless it exists already (the daemon's 409). */
async function ensureDataset(name: string): Promise<void> {
  try {
    await observeClient.createDataset({ name });
  } catch (error) {
    if (!(error instanceof ObserveApiError && error.status === 409)) throw error;
  }
}

function AddDialog({ traceId, onClose }: { traceId: string; onClose: () => void }) {
  const toast = useToast();
  const titleId = useId();
  const datasets = useDatasets({ limit: PICKER_LIMIT });
  const names = (datasets.data?.datasets ?? []).map((d) => d.name);
  const [choice, setChoice] = useState<string | undefined>();
  const [newName, setNewName] = useState('');
  const [saving, setSaving] = useState(false);
  const firstField = useRef<HTMLSelectElement>(null);
  // Until the user picks, the newest dataset is preselected (or "new" when there are none).
  const selected = choice ?? names[0] ?? NEW;
  const target = selected === NEW ? newName.trim() : selected;

  useEffect(() => firstField.current?.focus(), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!target) return;
    setSaving(true);
    try {
      if (selected === NEW) await ensureDataset(target);
      await observeClient.addExample(target, { from_trace_id: traceId });
      toast.show({
        tone: 'success',
        message: `Added trace to ${target}.`,
        action: { label: 'Open dataset', onClick: () => navigate(datasetPath(target)) },
      });
      onClose();
    } catch (error) {
      toast.show({ tone: 'error', message: `Could not add the trace to ${target}: ${(error as Error).message}` });
      setSaving(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    onClose();
  };

  return (
    <div className="add-to-dataset-dialog" role="dialog" aria-label="Add to dataset" onKeyDown={onKeyDown}>
      <form onSubmit={(e) => void submit(e)} aria-labelledby={titleId}>
        <h3 id={titleId} className="datasets-section-title">
          Add this trace to a dataset
        </h3>
        <label className="datasets-field">
          <span>Dataset</span>
          <select ref={firstField} value={selected} onChange={(e) => setChoice(e.target.value)}>
            {names.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
            <option value={NEW}>New dataset...</option>
          </select>
        </label>
        {selected === NEW && (
          <label className="datasets-field">
            <span>New dataset name</span>
            <input name="new-dataset-name" type="text" value={newName} onChange={(e) => setNewName(e.target.value)} />
          </label>
        )}
        <div className="add-to-dataset-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={saving || !target}>
            Add
          </button>
        </div>
      </form>
    </div>
  );
}

/** The trace header's "Add to dataset" button and its dialog. */
export function AddToDataset({ traceId }: { traceId: string }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <div className="add-to-dataset">
      <button
        ref={trigger}
        type="button"
        className="btn btn-ghost"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        Add to dataset
      </button>
      {open && <AddDialog traceId={traceId} onClose={close} />}
    </div>
  );
}
