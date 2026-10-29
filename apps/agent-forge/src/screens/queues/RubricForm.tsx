/**
 * The review view's score card: per rubric entry a numeric input (its min/max
 * as the input's bounds; blank means "not scored" and is left out), quick-pick
 * score buttons when the bounds are a small whole-number range, and an
 * optional comment; then `Skip` and `Submit & next`, with their keys shown.
 *
 * Keys: Enter submits unless focus is on a control Enter already means
 * something to (a button, a link, a select); inside the form's own inputs the
 * browser's implicit submit does it, and in a comment Enter submits too
 * (Shift+Enter is a new line). `S` skips unless the user is typing (input,
 * textarea, select, contenteditable).
 */
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { isEditableTarget } from '../../canvas/isEditableTarget';
import { ObserveApiError, observeClient } from '../../observe/observeClient';
import type { NewQueueScore, ObserveQueue, ObserveQueueItem } from '../../observe/types';
import { useToast } from '../../ui/Toast';
import { rubricRange } from './queuesUrl';

type Drafts = Record<string, Draft>;
type Draft = { value: string; comment: string };

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

/** Whole-number score buttons for an entry bounded by a small integer range (at most 11 values), else none. */
function scoreChoices(entry: ObserveQueue['rubric'][number]): number[] {
  const { min, max } = entry;
  if (min === undefined || max === undefined || !Number.isInteger(min) || !Number.isInteger(max)) return [];
  if (max < min || max - min > 10) return [];
  return Array.from({ length: max - min + 1 }, (_, i) => min + i);
}

/** In a comment, Enter submits the form (Shift+Enter keeps the new line). */
function submitOnEnter(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
  if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.nativeEvent.isComposing) return;
  e.preventDefault();
  e.currentTarget.form?.requestSubmit();
}


/** The quick-pick buttons; picking the chosen value again clears it (back to "not scored"). */
function ScoreChoices({ name, choices, draft, onChange }: { name: string; choices: number[]; draft: Draft; onChange: (next: Draft) => void }) {
  return (
    <div className="qu-choices" role="group" aria-label={`${name} score`}>
      {choices.map((v) => {
        const on = draft.value.trim() !== '' && Number(draft.value) === v;
        return (
          <button
            key={v}
            type="button"
            className="qu-choice"
            aria-pressed={on}
            onClick={() => onChange({ ...draft, value: on ? '' : String(v) })}
          >
            {v}
          </button>
        );
      })}
    </div>
  );
}

function ScoreField({
  entry,
  draft,
  onChange,
}: {
  entry: ObserveQueue['rubric'][number];
  draft: Draft;
  onChange: (next: Draft) => void;
}) {
  const id = useId();
  const choices = scoreChoices(entry);
  return (
    <div className="qu-score">
      <div className="qu-score-head">
        <label className="qu-score-name" htmlFor={`${id}-value`}>
          {entry.name}
        </label>
        <span className="qu-score-range" aria-hidden="true">
          {rubricRange(entry)}
        </span>
        <input
          id={`${id}-value`}
          className="input qu-score-input"
          name={`score-${entry.name}`}
          type="number"
          step="any"
          min={entry.min}
          max={entry.max}
          value={draft.value}
          placeholder="-"
          aria-describedby={entry.description ? `${id}-hint` : undefined}
          onChange={(e) => onChange({ ...draft, value: e.target.value })}
        />
      </div>
      {entry.description && (
        <p id={`${id}-hint`} className="qu-score-desc">
          {entry.description}
        </p>
      )}
      {choices.length > 0 && <ScoreChoices name={entry.name} choices={choices} draft={draft} onChange={onChange} />}
      <textarea
        className="textarea qu-comment"
        name={`comment-${entry.name}`}
        rows={2}
        aria-label={`Comment on ${entry.name} (optional)`}
        placeholder="Comment (optional)"
        value={draft.comment}
        onKeyDown={submitOnEnter}
        onChange={(e) => onChange({ ...draft, comment: e.target.value })}
      />
    </div>
  );
}

/** The score card for one item; `onDone` loads the next item after a submit, a skip or a 409. */
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

  const count = queue.rubric.length;
  return (
    <form ref={form} className="card qu-rubric-card" aria-label="Scores" onSubmit={submit}>
      <div className="qu-rubric-head">
        <h3 className="card-title">Scores</h3>
        <p className="card-description">{count === 1 ? '1 score; blank ones are left out' : `${count} scores; blank ones are left out`}</p>
      </div>
      <div className="qu-rubric-body">
        {count === 0 && <p className="datasets-note">This queue has no rubric: Submit marks the trace reviewed with no scores.</p>}
        {queue.rubric.map((entry) => (
          <ScoreField
            key={entry.name}
            entry={entry}
            draft={drafts[entry.name] ?? { value: '', comment: '' }}
            onChange={(next) => setDrafts((all) => ({ ...all, [entry.name]: next }))}
          />
        ))}
      </div>
      <div className="qu-rubric-footer">
        <button type="button" className="btn qu-skip" disabled={busy} onClick={skip} aria-keyshortcuts="S">
          Skip
          <kbd aria-hidden="true">S</kbd>
        </button>
        <button type="submit" className="btn btn-primary qu-submit" disabled={busy} aria-keyshortcuts="Enter">
          Submit &amp; next
          <kbd aria-hidden="true">↵</kbd>
        </button>
      </div>
    </form>
  );
}
