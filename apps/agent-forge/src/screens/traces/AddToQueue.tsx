/**
 * "Add to queue" on the trace header: a button opening a small dialog that
 * lists the annotation queues, then posts
 * `POST /api/v1/queues/:id/items { trace_ids: [traceId] }`. The outcome is a
 * toast (a trace already in the queue says so); success links to the review
 * view. With no queues yet the dialog links to the queue list to create one.
 */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { navigate } from '../../router/router';
import { useQueues } from '../../observe/useObserve';
import { observeClient } from '../../observe/observeClient';
import { useToast } from '../../ui/Toast';
import { queuePath } from '../queues/queuesUrl';
import { HeaderPopover } from './HeaderPopover';

/** The queue picker lists at most this many (the daemon's max page). */
const PICKER_LIMIT = 1000;

function QueueDialog({ traceId, onClose }: { traceId: string; onClose: () => void }) {
  const toast = useToast();
  const titleId = useId();
  const queues = useQueues({ limit: PICKER_LIMIT });
  const rows = queues.data?.queues ?? [];
  const [choice, setChoice] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const firstField = useRef<HTMLSelectElement>(null);
  const selected = rows.find((q) => q.queue_id === choice) ?? rows[0];

  useEffect(() => firstField.current?.focus(), [rows.length]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setSaving(true);
    try {
      const result = await observeClient.addQueueItems(selected.queue_id, [traceId]);
      toast.show({
        tone: 'success',
        message: result.added.length > 0 ? `Added trace to ${selected.name}.` : `The trace is already in ${selected.name}.`,
        action: { label: 'Review queue', onClick: () => navigate(queuePath(selected.queue_id)) },
      });
      onClose();
    } catch (error) {
      toast.show({ tone: 'error', message: `Could not add the trace to ${selected.name}: ${(error as Error).message}` });
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} aria-labelledby={titleId}>
      <h3 id={titleId} className="datasets-section-title">
        Add this trace to an annotation queue
      </h3>
      {queues.data && rows.length === 0 ? (
        <p className="datasets-note">
          No queues yet. <a href="#/evals/queues">Create one</a> first.
        </p>
      ) : (
        <label className="datasets-field">
          <span>Queue</span>
          <select ref={firstField} value={selected?.queue_id ?? ''} onChange={(e) => setChoice(e.target.value)}>
            {rows.map((q) => (
              <option key={q.queue_id} value={q.queue_id}>
                {q.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="add-to-dataset-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn" disabled={saving || !selected}>
          Add
        </button>
      </div>
    </form>
  );
}

/** The trace header's "Add to queue" button and its dialog. */
export function AddToQueue({ traceId }: { traceId: string }) {
  return <HeaderPopover label="Add to queue">{(close) => <QueueDialog traceId={traceId} onClose={close} />}</HeaderPopover>;
}
