import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageSquare } from 'lucide-react';

import { LOW_RATING_MAX, RATING_LABELS } from '../../shared/wireTypes';
import { runtimeClient, RuntimeApiError } from '../runtime/runtimeClient';
import { useToast } from './Toast';
import './rating.css';

export interface RatingControlProps {
  agentId: string;
  traceId: string;
  /** The run's current rating; `null` = unrated. */
  value: number | null;
  /** `sm` for table rows, `md` (default) elsewhere. */
  size?: 'sm' | 'md';
  /** Runs after a rating is saved so the caller can refresh its data. */
  onRated?: (value: number) => void;
}

const OBSERVE_DOWN = 'The observe daemon is not running. Start it with lousho observe.';

const errorText = (error: unknown): string => {
  if (error instanceof RuntimeApiError && error.status === 502) return OBSERVE_DOWN;
  return error instanceof Error ? error.message : 'Request failed';
};

const successMessage = (value: number): string =>
  value >= LOW_RATING_MAX + 1 ? 'Thanks — rating saved' : `Rating saved. It's in your Inbox so you can turn it into a test case.`;

/**
 * The 1-5 run rating (R04b): a radiogroup of numbered options - options at
 * or below the selection carry `rating-option-on` - plus a comment
 * popover that re-sends the current value with the note. Click or
 * Arrow Left/Right selects; a failed save reverts and toasts.
 */
export function RatingControl({ agentId, traceId, value, size = 'md', onRated }: RatingControlProps) {
  const toast = useToast();
  const [override, setOverride] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [commentOpen, setCommentOpen] = useState(false);
  const [comment, setComment] = useState('');
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // A fresh server value (refetch after save, another raters' write)
  // replaces the optimistic one.
  useEffect(() => setOverride(null), [value]);

  const current = override ?? value;
  if (traceId === '') return null;

  const save = useCallback(
    async (next: number, note?: string) => {
      setSaving(true);
      setOverride(next);
      try {
        await runtimeClient.rateRun(agentId, {
          traceId,
          value: next as 1 | 2 | 3 | 4 | 5,
          ...(note !== undefined && note.trim() !== '' ? { comment: note.trim() } : {}),
        });
        toast.show({ message: successMessage(next), tone: 'success' });
        onRated?.(next);
      } catch (error) {
        setOverride(null);
        toast.show({ message: errorText(error), tone: 'error' });
      } finally {
        setSaving(false);
      }
    },
    [agentId, traceId, toast, onRated],
  );

  const pick = useCallback(
    (next: number) => {
      if (saving) return;
      void save(next);
    },
    [saving, save],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      if (saving) return;
      const step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
      const from = current ?? (step === 1 ? 0 : RATING_LABELS.length);
      const next = ((from - 1 + step + RATING_LABELS.length) % RATING_LABELS.length) + 1;
      optionRefs.current[next - 1]?.focus();
      pick(next);
    },
    [saving, current, pick],
  );

  const tabStop = current ?? 1;
  const groupLabel = 'Rate this run';

  return (
    <div className={`rating-wrap rating-wrap-${size}`}>
      <div
        className="rating"
        role="radiogroup"
        aria-label={groupLabel}
        aria-busy={saving || undefined}
        onKeyDown={onKeyDown}
      >
        {RATING_LABELS.map((label, index) => {
          const n = index + 1;
          const on = current !== null && n <= current;
          const checked = current === n;
          return (
            <button
              key={n}
              ref={(el) => {
                optionRefs.current[index] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={`${n}, ${label}`}
              title={saving ? 'Saving…' : label}
              tabIndex={n === tabStop ? 0 : -1}
              disabled={saving}
              className={on ? 'rating-option rating-option-on' : 'rating-option'}
              onClick={() => pick(n)}
            >
              {n}
            </button>
          );
        })}
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm rating-comment"
          aria-label="Add a comment"
          title={saving ? 'Saving…' : 'Add a comment'}
          aria-expanded={commentOpen}
          disabled={saving}
          onClick={() => setCommentOpen((open) => !open)}
        >
          <MessageSquare size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      {commentOpen && (
        <div className="rating-popover" role="dialog" aria-label="Comment on this rating">
          <label className="visually-hidden" htmlFor={`rating-comment-${traceId}`}>
            Comment on this rating
          </label>
          <textarea
            id={`rating-comment-${traceId}`}
            className="textarea"
            rows={2}
            maxLength={2000}
            placeholder="What went wrong or right?"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
          <div className="rating-popover-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={saving || current === null}
              onClick={() => {
                if (current === null) return;
                const note = comment;
                setComment('');
                setCommentOpen(false);
                void save(current, note);
              }}
            >
              Save
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCommentOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
