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

/** The arrow-key step: Left/Up go down, Right/Down go up, wrapping at the ends. */
function steppedValue(current: number | null, key: string): number | null {
  const step = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
  const from = current ?? (step === 1 ? 0 : RATING_LABELS.length);
  return ((from - 1 + step + RATING_LABELS.length) % RATING_LABELS.length) + 1;
}

interface CommentPopoverProps {
  traceId: string;
  comment: string;
  onComment: (value: string) => void;
  saving: boolean;
  /** The rating the comment rides on; `null` disables Save. */
  current: number | null;
  onSave: (note: string) => void;
  onClose: () => void;
}

/** The comment popover: textarea plus Save (re-sends `current` with the note) and Cancel. */
function CommentPopover({ traceId, comment, onComment, saving, current, onSave, onClose }: CommentPopoverProps) {
  return (
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
        onChange={(event) => onComment(event.target.value)}
      />
      <div className="rating-popover-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={saving || current === null}
          onClick={() => {
            if (current !== null) onSave(comment);
          }}
        >
          Save
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The 1-5 run rating (R04b): a radiogroup of numbered options - options at
 * or below the selection carry `rating-option-on` - plus a comment
 * popover that re-sends the current value with the note. Click or
 * Arrow Left/Right selects; a failed save reverts and toasts.
 */
interface RatingScaleProps {
  current: number | null;
  saving: boolean;
  commentOpen: boolean;
  onPick: (next: number) => void;
}

/** The 1-5 radiogroup: numbered options plus the comment-toggle button. */
function RatingScale({ current, saving, commentOpen, onPick }: RatingScaleProps) {
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const tabStop = current ?? 1;

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    if (saving) return;
    const next = steppedValue(current, event.key);
    if (next === null) return;
    optionRefs.current[next - 1]?.focus();
    onPick(next);
  };

  return (
    <div
      className="rating"
      role="radiogroup"
      aria-label="Rate this run"
      aria-busy={saving || undefined}
      onKeyDown={onKeyDown}
    >
      {RATING_LABELS.map((label, index) => {
        const n = index + 1;
        const on = current !== null && n <= current;
        return (
          <button
            key={n}
            ref={(el) => {
              optionRefs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={current === n}
            aria-label={`${n}, ${label}`}
            title={saving ? 'Saving…' : label}
            tabIndex={n === tabStop ? 0 : -1}
            disabled={saving}
            className={on ? 'rating-option rating-option-on' : 'rating-option'}
            onClick={() => onPick(n)}
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
        onClick={() => onPick(-1)}
      >
        <MessageSquare size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  );
}

export function RatingControl({ agentId, traceId, value, size = 'md', onRated }: RatingControlProps) {
  const toast = useToast();
  const [override, setOverride] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [commentOpen, setCommentOpen] = useState(false);
  const [comment, setComment] = useState('');

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

  // -1 is the comment toggle, not a rating.
  const onScalePick = useCallback(
    (next: number) => {
      if (next === -1) {
        setCommentOpen((open) => !open);
        return;
      }
      if (!saving) void save(next);
    },
    [saving, save],
  );

  return (
    <div className={`rating-wrap rating-wrap-${size}`}>
      <RatingScale current={current} saving={saving} commentOpen={commentOpen} onPick={onScalePick} />
      {commentOpen && (
        <CommentPopover
          traceId={traceId}
          comment={comment}
          onComment={setComment}
          saving={saving}
          current={current}
          onSave={(note) => {
            setComment('');
            setCommentOpen(false);
            if (current !== null) void save(current, note);
          }}
          onClose={() => setCommentOpen(false)}
        />
      )}
    </div>
  );
}
