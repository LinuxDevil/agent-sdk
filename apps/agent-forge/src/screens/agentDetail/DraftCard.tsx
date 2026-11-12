import { useCallback, useState } from 'react';
import { Shield, ShieldAlert, ShieldCheck } from 'lucide-react';

import { errorMessage } from '../../components/errorMessage';
import { fmtAge } from '../../observe/format';
import { runtimeClient } from '../../runtime/runtimeClient';
import { useAppState } from '../../state/AppState';
import { useToast } from '../../ui/Toast';
import { Field } from '../../ui/Field';
import { Textarea } from '../../ui/controls';
import { ChangeList } from '../../ui/ChangeList';
import { toChangeItem } from '../../ui/changeValue';
import { useAgentDetail } from './AgentDetailContext';
import { fieldLabel } from './versionLabels';
import type { DraftAutoReview, DraftConcern, DraftView, SpecChange } from '../../../shared/wireTypes';
import './draftCard.css';

/** The chip text of each draft origin (L11b's header copy). */
const ORIGIN_LABELS = {
  author: 'From the Author',
  suggestion: 'From a suggestion',
  manual: 'Added by you',
} as const;

/** The concern chip's label per rubric area. */
const CONCERN_LABELS: Record<DraftConcern['area'], string> = {
  safety: 'Safety',
  coherence: 'Fits the agent?',
  trigger_reach: 'Who can start it',
};

/** The review block's copy per outcome; `pending` is the pre-verdict skeleton. */
const REVIEW_COPY = {
  clear: { Icon: ShieldCheck, title: 'No safety concerns found.' },
  escalated: { Icon: ShieldAlert, title: 'Read this change carefully.' },
  unavailable: { Icon: Shield, title: '' },
} as const;

type ReviewOutcome = keyof typeof REVIEW_COPY | 'pending';

/** The top-level spec key of a `SpecChange.field` path ('tools[web-fetch]' → 'tools'). */
function topKeyOf(field: string): string {
  return field.split(/[.[\]]/)[0];
}

/** The gated line's verb per diff op. */
const OP_VERBS = { add: 'adds', remove: 'removes', edit: 'changes' } as const;

/**
 * The "Needs your approval" sentence: `classes.gated` paths grouped by
 * top-level key (first-appearance order), each labelled through
 * `fieldLabel` with the verb of the matching `SpecChange`'s op -
 * `changes Model, adds Tools.`
 */
function gatedSentence(gated: string[], changes: SpecChange[]): string {
  const byKey = new Map<string, string[]>();
  for (const path of gated) {
    const key = topKeyOf(path);
    const paths = byKey.get(key);
    if (paths) paths.push(path);
    else byKey.set(key, [path]);
  }
  const parts: string[] = [];
  for (const [key, paths] of byKey) {
    const change =
      paths.map((path) => changes.find((c) => c.field === path)).find((c) => c !== undefined) ??
      changes.find((c) => topKeyOf(c.field) === key);
    parts.push(`${change === undefined ? 'changes' : OP_VERBS[change.op]} ${fieldLabel(key)}`);
  }
  return parts.join(', ');
}

/** The auto-review verdict block: skeleton while pending, then icon + copy + concerns per outcome. */
function DraftReview({ review }: { review: DraftAutoReview | null }): JSX.Element {
  const outcome: ReviewOutcome = review?.outcome ?? 'pending';
  return (
    <div className="draft-review" data-outcome={outcome}>
      {review === null ? (
        <p className="draft-review-line">
          <span className="skeleton draft-review-skeleton" aria-hidden="true" />
          Checking this change…
        </p>
      ) : (
        <ReviewVerdict outcome={review.outcome} review={review} />
      )}
      {review !== null && review.concerns.length > 0 && (
        <ul className="draft-concerns">
          {review.concerns.map((concern, i) => (
            <li key={i}>
              <span className="chip">{CONCERN_LABELS[concern.area]}</span> {concern.detail}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The settled verdict's icon, headline and rationale (never rendered for `pending`). */
function ReviewVerdict({ outcome, review }: { outcome: Exclude<ReviewOutcome, 'pending'>; review: DraftAutoReview }): JSX.Element {
  const { Icon, title } = REVIEW_COPY[outcome];
  return (
    <p className="draft-review-line">
      <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
      {title !== '' && (
        <>
          <strong>{title}</strong>{' '}
        </>
      )}
      {review.rationale}
    </p>
  );
}

/** The "Needs your approval" line; renders nothing when every field is routine (or unclassified). */
function DraftGated({ draft }: { draft: DraftView }): JSX.Element | null {
  const gated = draft.classes?.gated ?? [];
  if (gated.length === 0) return null;
  return (
    <p className="draft-gated">
      <strong>Needs your approval:</strong> {gatedSentence(gated, draft.changes)}.
    </p>
  );
}

/** The reject note form that expands under the footer's Reject button. */
function RejectForm({
  note,
  busy,
  onNote,
  onConfirm,
  onCancel,
}: {
  note: string;
  busy: boolean;
  onNote(note: string): void;
  onConfirm(): void;
  onCancel(): void;
}): JSX.Element {
  return (
    <div className="draft-reject">
      <Field label="Note (optional)">
        <Textarea rows={2} value={note} onChange={(e) => onNote(e.target.value)} />
      </Field>
      <div className="draft-card-actions">
        <button type="button" className="btn btn-primary btn-sm" onClick={onConfirm} disabled={busy}>
          Reject change
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Props for {@link DraftCard}. */
export interface DraftCardProps {
  agentId: string;
  draft: DraftView;
  /** Called after approve/reject settles the draft so the parent refetches (the card disappears). */
  onResolved(): void;
}

/**
 * The pending `ChangeDraft` card on the Suggestions tab (L11b): origin,
 * reason, the L11a auto-review verdict, the gated-fields line, the patch's
 * `ChangeList` and Approve/Reject. Approve applies the patch server-side
 * (a `source: 'draft'` version), reloads the open editor document and
 * refreshes the record; Reject optionally records a note. Errors keep the
 * card and re-enable the buttons.
 */
export function DraftCard({ agentId, draft, onResolved }: DraftCardProps): JSX.Element {
  const toast = useToast();
  const app = useAppState();
  const { refresh } = useAgentDetail();
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  const approve = useCallback(async () => {
    setBusy('approve');
    setError(undefined);
    try {
      await runtimeClient.approveDraft(agentId, { draftId: draft.id });
      toast.show({ message: `Applied the change as v${draft.currentVersion + 1}`, tone: 'success' });
      void app.reload({ discardLocal: true });
      refresh();
      onResolved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }, [agentId, app, draft.currentVersion, draft.id, onResolved, refresh, toast]);

  const reject = useCallback(async () => {
    setBusy('reject');
    setError(undefined);
    try {
      await runtimeClient.rejectDraft(agentId, { draftId: draft.id, note: note.trim() === '' ? undefined : note.trim() });
      toast.show({ message: 'Rejected the change', tone: 'info' });
      onResolved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
      setRejecting(false);
    }
  }, [agentId, draft.id, note, onResolved, toast]);

  const drifted = draft.baseVersion !== null && draft.currentVersion > draft.baseVersion;

  return (
    <section className="draft-card" aria-labelledby="draft-title">
      <header className="draft-card-header">
        <h2 id="draft-title" className="draft-card-title">
          Pending change
        </h2>
        <span className="chip">{ORIGIN_LABELS[draft.origin]}</span>
        <time className="draft-card-time" dateTime={draft.createdAt}>
          {fmtAge(Date.now() - Date.parse(draft.createdAt))}
        </time>
      </header>
      <p className="draft-card-reason">{draft.reason}</p>

      {drifted && (
        <div className="draft-drift" role="status">
          The agent changed since this draft was made (v{draft.baseVersion} → v{draft.currentVersion}). Approving applies
          the draft on top of v{draft.currentVersion}.
        </div>
      )}

      <DraftReview review={draft.autoReview} />
      <DraftGated draft={draft} />
      <ChangeList changes={draft.changes.map(toChangeItem)} />

      {error !== undefined && (
        <p className="draft-error" role="alert">
          {error}
        </p>
      )}

      {rejecting ? (
        <RejectForm note={note} busy={busy !== null} onNote={setNote} onConfirm={() => void reject()} onCancel={() => setRejecting(false)} />
      ) : (
        <footer className="draft-card-actions">
          <button type="button" className="btn btn-primary" onClick={() => void approve()} disabled={busy !== null}>
            Approve
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setRejecting(true)} disabled={busy !== null}>
            Reject
          </button>
        </footer>
      )}
    </section>
  );
}
