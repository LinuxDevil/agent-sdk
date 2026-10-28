/**
 * The review view's score form: one numeric input per rubric entry (its
 * min/max as the input's bounds; blank means "not scored" and is left out)
 * with an optional comment each, then `Submit` and `Skip`.
 *
 * Keys: Enter submits unless focus is in a textarea or on a control Enter
 * already means something to (a button, a link, a select); inside the form's
 * own inputs the browser's implicit submit does it. `S` skips unless the user
 * is typing (input, textarea, select, contenteditable).
 */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { isEditableTarget } from '../../canvas/isEditableTarget';
import { ObserveApiError, observeClient } from '../../observe/observeClient';
import type { NewQueueScore, ObserveQueue, ObserveQueueItem } from '../../observe/types';
import { useToast } from '../../ui/Toast';

type Drafts = Record<string, { value: string; comment: string }>;

/** Controls where a plain Enter already has a meaning of its own (an input's is the form's implicit submit). */
const ENTER_OWNERS = 'a[href], button, input, select, textarea, summary, [contenteditable=""], [contenteditable="true"], [role="button"], [role="link"], [role="tab"], [role="option"], [role="menuitem"], [role="treeitem"]';

/** Which review action a keydown is, if any. */
function reviewKey(e: KeyboardEvent): 'submit' | 'skip' | null {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return null;
  if (e.key === 'Enter') {
    const target = e.target as Element | null;
    return typeof target?.closest === 'function' && target.closest(ENTER_OWNERS) ? null : 'submit';
  }
  if (e.key === 's' || e.key === 'S') return isEditableTarget(e.target) ? null : 'skip';
  return null;
}

/** The scored entries, in rubric order: blank values left out, comments trimmed and only when given. */
function toScores(queue: ObserveQueue, drafts: Drafts): NewQueueScore[] {
  const scores: NewQueueScore[] = [];
  for (const { name } of queue.rubric) {
    const draft = drafts[name];
    if (!draft || draft.value.trim() === '') continue;
    const comment = draft.comment.trim();
    scores.push(comment ? { name, value: Number(draft.value), comment } : { name, value: Number(draft.value) });
  }
  return scores;
}

/** Posts one item's outcome; a 409 (finished elsewhere) toasts and moves on, other failures toast and stay. */
function useComplete(queue: ObserveQueue, item: ObserveQueueItem, onDone: () => void) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const complete = async (outcome: { scores: NewQueueScore[]; status?: 'skipped' }) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await observeClient.completeQueueItem(queue.queue_id, item.item_id, outcome);
      onDone();
    } catch (error) {
      busyRef.current = false;
      setBusy(false);
      if (error instanceof ObserveApiError && error.status === 409) {
        toast.show({ tone: 'info', message: 'That item was already finished elsewhere; loading the next one.' });
        onDone();
        return;
      }
      toast.show({ tone: 'error', message: `Could not save the review: ${(error as Error).message}` });
    }
  };
  return { busy, complete };
}

function ScoreField({
  entry,
  draft,
  onChange,
}: {
  entry: ObserveQueue['rubric'][number];
  draft: { value: string; comment: string };
  onChange: (next: { value: string; comment: string }) => void;
}) {
  const hintId = useId();
  return (
    <div className="queues-score">
      <label className="datasets-field">
        <span>{entry.name}</span>
        <input
          name={`score-${entry.name}`}
          type="number"
          step="any"
          min={entry.min}
          max={entry.max}
          value={draft.value}
          aria-describedby={entry.description ? hintId : undefined}
          onChange={(e) => onChange({ ...draft, value: e.target.value })}
        />
      </label>
      {entry.description && (
        <p id={hintId} className="datasets-note">
          {entry.description}
        </p>
      )}
      <input
        className="queues-comment"
        name={`comment-${entry.name}`}
        type="text"
        aria-label={`Comment on ${entry.name} (optional)`}
        placeholder="Comment (optional)"
        value={draft.comment}
        onChange={(e) => onChange({ ...draft, comment: e.target.value })}
      />
    </div>
  );
}

/** The score form for one item; `onDone` loads the next item after a submit, a skip or a 409. */
export function RubricForm({ queue, item, onDone }: { queue: ObserveQueue; item: ObserveQueueItem; onDone: () => void }) {
  const [drafts, setDrafts] = useState<Drafts>({});
  const { busy, complete } = useComplete(queue, item, onDone);
  const form = useRef<HTMLFormElement>(null);
  const skip = () => void complete({ scores: [], status: 'skipped' });
  const skipRef = useRef(skip);
  skipRef.current = skip;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const action = reviewKey(e);
      if (action === null) return;
      e.preventDefault();
      if (action === 'skip') skipRef.current();
      else form.current?.requestSubmit();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void complete({ scores: toScores(queue, drafts) });
  };

  return (
    <form ref={form} className="queues-rubric-form" aria-label="Scores" onSubmit={submit}>
      <h3 className="datasets-section-title">Scores</h3>
      {queue.rubric.length === 0 && <p className="datasets-note">This queue has no rubric: Submit marks the trace reviewed with no scores.</p>}
      {queue.rubric.map((entry) => (
        <ScoreField
          key={entry.name}
          entry={entry}
          draft={drafts[entry.name] ?? { value: '', comment: '' }}
          onChange={(next) => setDrafts((all) => ({ ...all, [entry.name]: next }))}
        />
      ))}
      <div className="queues-form-actions">
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={skip} aria-keyshortcuts="S">
          Skip
        </button>
        <button type="submit" className="btn" disabled={busy} aria-keyshortcuts="Enter">
          Submit
        </button>
      </div>
      <p className="datasets-note queues-keys">Enter submits, S skips.</p>
    </form>
  );
}
