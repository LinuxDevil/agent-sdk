import { Inbox } from 'lucide-react';

import { EmptyState } from '../../ui/EmptyState';
import { Skeleton } from '../../ui/Skeleton';
import { useAgentDetail } from './AgentDetailContext';
import { DraftCard } from './DraftCard';
import { PromptSuggestions } from './PromptSuggestions';
import { useDraftView } from './useDraftView';
import './suggestions.css';

/**
 * The Suggestions tab (L11b + R06): the agent's pending `ChangeDraft`
 * review card on top, then {@link PromptSuggestions} - the
 * prompt-suggestion cards the `prompt_suggestion` pass writes, with the
 * `?suggesting=<id>` pending skeleton every "Suggest a fix" entry point
 * links to.
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

  return (
    <div className="suggestions-tab">
      {draft !== undefined && <DraftCard agentId={record.id} draft={draft} onResolved={() => void refresh()} />}
      <PromptSuggestions agentId={record.id} promptRef={record.spec.promptRef} hasDraft={draft !== undefined} />
    </div>
  );
}
