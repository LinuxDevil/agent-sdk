import { Inbox } from 'lucide-react';

import { EmptyState } from '../../ui/EmptyState';
import { Skeleton } from '../../ui/Skeleton';
import { useAgentDetail } from './AgentDetailContext';
import { DraftCard } from './DraftCard';
import { useDraftView } from './useDraftView';
import './suggestions.css';

/**
 * The Suggestions tab (L11b): the agent's pending `ChangeDraft` as a
 * review card - R06 adds the prompt-suggestion list below it. Loads the
 * `DraftView` on mount, refetches on `draft.changed`/`agent.changed`,
 * and shows the shared empty state when nothing waits for review.
 */
export function SuggestionsTab(): JSX.Element {
  const { record } = useAgentDetail();
  const { draft, error, loading, refresh } = useDraftView(record.id);

  if (loading && draft === undefined && error === undefined) {
    return (
      <div className="suggestions-tab" role="status" aria-label="Loading suggestions">
        <Skeleton width="100%" height={28} />
        <Skeleton width="100%" height={120} />
      </div>
    );
  }

  if (error !== undefined) {
    return (
      <div className="suggestions-tab">
        <EmptyState
          icon={Inbox}
          title="Could not load suggestions"
          hint={error}
          action={
            <button type="button" className="btn" onClick={() => void refresh()}>
              Retry
            </button>
          }
        />
      </div>
    );
  }

  if (draft === undefined) {
    return (
      <div className="suggestions-tab">
        <EmptyState
          icon={Inbox}
          title="Nothing to review"
          hint="Drafts from the Author and suggestions from runs show up here."
        />
      </div>
    );
  }

  return (
    <div className="suggestions-tab">
      <DraftCard agentId={record.id} draft={draft} onResolved={() => void refresh()} />
    </div>
  );
}
