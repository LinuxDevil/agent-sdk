import { useState, type FormEvent } from 'react';

import { observeClient } from '../../observe/observeClient';
import type { ObserveObservationRow } from '../../observe/types';
import { useToast } from '../../ui/Toast';

/** The score name human thumbs up/down feedback is stored under. */
const FEEDBACK_SCORE_NAME = 'feedback';

const CHOICES: { value: 1 | 0; label: string; glyph: string }[] = [
  { value: 1, label: 'Thumbs up', glyph: '\u{1F44D}' },
  { value: 0, label: 'Thumbs down', glyph: '\u{1F44E}' },
];

/**
 * Human feedback on one observation: thumbs up (1) / down (0) plus an
 * optional comment, posted as a `feedback` score (`POST /api/v1/scores`).
 * A root observation's feedback scores the whole trace (no `obs_id`).
 * `onSaved` runs after a successful write so the caller can refetch.
 */
export function TraceFeedback({ observation, onSaved }: { observation: ObserveObservationRow; onSaved: () => void }) {
  const toast = useToast();
  const [value, setValue] = useState<1 | 0 | undefined>(undefined);
  const [comment, setComment] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value === undefined || saving) return;
    const text = comment.trim();
    setSaving(true);
    observeClient
      .postScore({
        trace_id: observation.trace_id,
        ...(observation.parent_obs_id === null ? {} : { obs_id: observation.obs_id }),
        name: FEEDBACK_SCORE_NAME,
        value,
        ...(text ? { comment: text } : {}),
      })
      .then(
        () => {
          toast.show({ message: 'Feedback saved', tone: 'success' });
          setValue(undefined);
          setComment('');
          onSaved();
        },
        (error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          toast.show({ message: `Could not save feedback: ${reason}`, tone: 'error' });
        },
      )
      .finally(() => setSaving(false));
  };

  return (
    <form className="trace-feedback" aria-label="Add feedback" onSubmit={submit}>
      <div className="trace-feedback-choices" role="group" aria-label="Rating">
        {CHOICES.map((choice) => (
          <button
            key={choice.value}
            type="button"
            className="btn btn-ghost trace-feedback-choice"
            aria-label={choice.label}
            aria-pressed={value === choice.value}
            onClick={() => setValue(value === choice.value ? undefined : choice.value)}
          >
            <span aria-hidden="true">{choice.glyph}</span>
          </button>
        ))}
      </div>
      <label className="trace-feedback-comment">
        <span className="visually-hidden">Comment (optional)</span>
        <textarea
          rows={2}
          placeholder="Comment (optional)"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </label>
      <button type="submit" className="btn btn-primary" disabled={value === undefined || saving}>
        {saving ? 'Saving...' : 'Send feedback'}
      </button>
    </form>
  );
}
