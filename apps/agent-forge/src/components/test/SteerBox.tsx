import { useState } from 'react';
import { CornerDownRight } from 'lucide-react';
import { useAppState } from '../../state/AppState';
import type { SteerDelivery, SteerInfo } from '../../../shared/wireTypes';
import { StatusBadge } from '../../ui/StatusBadge';
import type { StatusKey } from '../../ui/status';
import { formatTime } from '../formatTime';

/** `SteerRequest.message`'s server-side cap (1..3000 chars after trim). */
const MAX_MESSAGE = 3000;
/** The character counter only appears once the draft passes this length. */
const COUNTER_AT = 2500;

/** Each delivery state's badge: the StatusKey picks the tone, the label the words the ticket fixes. */
const DELIVERY_BADGE: Record<SteerDelivery, { status: StatusKey; label: string }> = {
  queued: { status: 'queued', label: 'Queued' },
  delivered: { status: 'done', label: 'Delivered' },
  undelivered: { status: 'error', label: 'Undelivered' },
};

function SteerItem({ item }: { item: SteerInfo }) {
  const badge = DELIVERY_BADGE[item.delivery];
  return (
    <li className={`steer-item steer-item-${item.delivery}`}>
      <div className="steer-item-head">
        <StatusBadge status={badge.status} label={badge.label} size="sm" />
        <span className="steer-item-time">{formatTime(item.at)}</span>
      </div>
      <div className="steer-item-message">{item.message}</div>
      {item.delivery === 'undelivered' && (
        <div className="steer-item-note">The run ended before this message was delivered.</div>
      )}
    </li>
  );
}

/**
 * The Test pane's "Message the running agent" box (T05): while a run is
 * `running` it offers a textarea that pushes a correction into the live
 * run's input queue (`steerRun` -> `POST /agents/:id/steer`), and below it
 * lists this run's steer messages with their Queued/Delivered/Undelivered
 * badges. The form hides when nothing is running; the list stays until the
 * next run launches (the status payload's `steering` resets then).
 */
export function SteerBox() {
  const { runStatus, steerRun } = useAppState();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const running = runStatus?.status === 'running';
  const steering = runStatus?.steering ?? [];
  // Hidden entirely when idle with no steer history; the list alone stays
  // visible after the run ends.
  if (!running && steering.length === 0) return null;

  async function handleSend() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(undefined);
    try {
      await steerRun(text);
      setDraft('');
    } catch (err) {
      // Keep the draft so the user can retry; the 409s (run ended, flow
      // run) surface verbatim.
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  return (
    <div className="steer-box">
      {running && (
        <div className="steer-form">
          <label className="steer-label" htmlFor="steer-input">
            Message the running agent
          </label>
          <div className="steer-input-row">
            <textarea
              id="steer-input"
              aria-label="Message the running agent"
              className="steer-input"
              rows={2}
              maxLength={MAX_MESSAGE}
              placeholder="Correct or add to the run in flight"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <button
              type="button"
              className="btn btn-primary btn-sm steer-send"
              onClick={() => void handleSend()}
              disabled={sending || !draft.trim()}
            >
              <CornerDownRight size={14} strokeWidth={1.75} aria-hidden="true" />
              Send to run
            </button>
          </div>
          {draft.length > COUNTER_AT && (
            <div className="steer-count" aria-live="polite">
              {draft.length}/{MAX_MESSAGE}
            </div>
          )}
          {error !== undefined && (
            <div className="steer-error" role="alert">
              {error}
            </div>
          )}
        </div>
      )}
      {steering.length > 0 && (
        <ul className="steer-list" aria-label="Steering messages">
          {steering.map((item) => (
            <SteerItem key={item.id} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}
