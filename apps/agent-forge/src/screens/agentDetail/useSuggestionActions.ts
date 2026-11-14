import { useState } from 'react';

import { errorMessage } from '../../components/errorMessage';
import { runtimeClient, RuntimeApiError } from '../../runtime/runtimeClient';
import { useSuggestFix } from '../../state/useSuggestFix';
import { useToast } from '../../ui/Toast';
import type { PromptSuggestion } from '../../../shared/wireTypes';

export type SuggestionBusy = 'apply' | 'dismiss' | 'again' | null;
export type SuggestionCardStatus = 'open' | 'applied' | 'conflict';

/** What the card's action handlers own: the in-flight op, local status overrides and the last error. */
export interface SuggestionActions {
  busy: SuggestionBusy;
  status: SuggestionCardStatus;
  /** The version a landed apply wrote (local until the refetched record carries it). */
  appliedVersion: number | null;
  error: string | undefined;
  apply(): Promise<void>;
  dismiss(): Promise<void>;
  suggestAgain(): Promise<void>;
}

/**
 * The SuggestionCard action handlers (R06): Apply is the server's
 * CAS-guarded rewrite (`LOUSHO_SUGGESTION_CONFLICT` flips the card to
 * its conflict state locally), Dismiss settles the record, and
 * "Suggest again" re-runs the pass on the source trace through the
 * shared `useSuggestFix` (which navigates with `?suggesting=<id>`).
 */
export function useSuggestionActions(agentId: string, suggestion: PromptSuggestion, onChanged: () => void): SuggestionActions {
  const toast = useToast();
  const suggestFix = useSuggestFix();
  const [busy, setBusy] = useState<SuggestionBusy>(null);
  const [conflict, setConflict] = useState(false);
  const [appliedVersion, setAppliedVersion] = useState<number | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  const run = async (op: Exclude<SuggestionBusy, null>, task: () => Promise<void>) => {
    setBusy(op);
    setError(undefined);
    try {
      await task();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const apply = () =>
    run('apply', async () => {
      try {
        const version = await runtimeClient.applySuggestion(agentId, suggestion.id);
        setAppliedVersion(version.version);
        toast.show({ message: `Instructions updated (v${version.version})`, tone: 'success' });
        onChanged();
      } catch (err) {
        if (err instanceof RuntimeApiError && err.code === 'LOUSHO_SUGGESTION_CONFLICT') {
          setConflict(true);
          onChanged();
          return;
        }
        throw err;
      }
    });

  const dismiss = () =>
    run('dismiss', async () => {
      await runtimeClient.dismissSuggestion(agentId, suggestion.id);
      toast.show({ message: 'Suggestion dismissed', tone: 'info' });
      onChanged();
    });

  const suggestAgain = () => run('again', () => suggestFix(agentId, suggestion.sourceTraceId));

  const status: SuggestionCardStatus =
    conflict || suggestion.status === 'conflict' ? 'conflict' : appliedVersion !== null || suggestion.status === 'applied' ? 'applied' : 'open';

  return { busy, status, appliedVersion, error, apply, dismiss, suggestAgain };
}
