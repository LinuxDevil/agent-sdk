import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';

import { useRoute } from '../../router/useRoute';
import { useToast } from '../../ui/Toast';
import { Skeleton } from '../../ui/Skeleton';
import { EmptyState } from '../../ui/EmptyState';
import { SuggestionCard } from './SuggestionCard';
import { useSuggestions } from './useSuggestions';

/** How long the "Working on a suggestion…" skeleton waits for `suggestion.new` before warning (R06). */
const PENDING_TIMEOUT_MS = 90_000;

/**
 * The `?suggesting=<id>` pending state (R06): true while the pass's
 * `suggestion.new` has not landed the record and the 90 s window is open;
 * expiry fires one warning toast. `arrived` flips it off the moment the
 * fetched list contains the id.
 */
function usePendingSuggestion(pendingId: string | null, arrived: boolean): boolean {
  const toast = useToast();
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    if (pendingId === null || arrived) return;
    setExpired(false);
    const timer = setTimeout(() => setExpired(true), PENDING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pendingId, arrived]);

  useEffect(() => {
    if (expired) toast.show({ message: "Couldn't make a suggestion for this run.", tone: 'warning' });
  }, [expired, toast]);

  return pendingId !== null && !arrived && !expired;
}

/** Props for {@link PromptSuggestions}. */
export interface PromptSuggestionsProps {
  agentId: string;
  /** `spec.promptRef` when set - cards warn that apply edits only the fallback text. */
  promptRef?: string;
  /** Whether the draft card above is showing - the empty state needs both halves empty. */
  hasDraft: boolean;
}

/**
 * The Suggestions tab's prompt-suggestion half (R06): the card list
 * newest first, the `?suggesting=<id>` skeleton while a pass runs, and
 * the shared empty state when neither a draft nor a suggestion waits.
 */
export function PromptSuggestions({ agentId, promptRef, hasDraft }: PromptSuggestionsProps): JSX.Element | null {
  const { suggestions, loading, refresh } = useSuggestions(agentId);
  const { query } = useRoute();
  const pendingId = query.get('suggesting');
  const pendingVisible = usePendingSuggestion(pendingId, suggestions.some((s) => s.id === pendingId));

  const showList = suggestions.length > 0 || pendingVisible || (loading && suggestions.length === 0);
  const showEmpty = !hasDraft && suggestions.length === 0 && !pendingVisible && !loading;
  if (!showList && !showEmpty) return null;

  return (
    <>
      {showList && (
        <section className="suggestions-list" aria-labelledby="suggestions-title">
          <h2 id="suggestions-title" className="card-title">
            Suggestions
          </h2>
          {loading && suggestions.length === 0 && (
            <>
              <Skeleton width="100%" height={28} />
              <Skeleton width="100%" height={120} />
            </>
          )}
          {pendingVisible && (
            <div className="suggestion-card suggestion-card-pending" role="status">
              <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" /> Working on a suggestion…
            </div>
          )}
          {suggestions.map((suggestion) => (
            <SuggestionCard
              key={suggestion.id}
              agentId={agentId}
              suggestion={suggestion}
              promptRef={promptRef}
              onChanged={() => void refresh()}
            />
          ))}
        </section>
      )}
      {showEmpty && (
        <EmptyState
          icon={Sparkles}
          title="No suggestions yet"
          hint="Rate a run 2 or lower, or use Suggest a fix on a run, to get a suggested instruction change."
        />
      )}
    </>
  );
}
