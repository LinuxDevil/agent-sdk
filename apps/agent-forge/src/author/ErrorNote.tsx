import { CircleAlert } from 'lucide-react';
import './authorCards.css';

/** Props for {@link ErrorNote}. */
export interface ErrorNoteProps {
  /** The person-facing failure line (plain words, no tool names or ids). */
  message: string;
  /** One inline recovery button (`Try again`, `Open Settings`, …); omitted when there is nothing to click. */
  action?: { label: string; onClick(): void };
}

/**
 * The one-line failure card (PLAN §11 Author dock): a failed save part,
 * a mid-turn `turn.error` or the reattach give-up all read as the same
 * tinted note. Optional `action` is a single recovery affordance - the
 * note stays quiet when the only fix is outside the chat.
 */
export function ErrorNote({ message, action }: ErrorNoteProps): JSX.Element {
  return (
    <p className="error-note" role="alert">
      <CircleAlert size={16} strokeWidth={1.75} aria-hidden="true" />
      <span>{message}</span>
      {action !== undefined && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </p>
  );
}
