import { useCallback } from 'react';

import { runtimeClient } from '../runtime/runtimeClient';
import { navigate } from '../router/router';

/**
 * The "Suggest a fix" action every surface shares (R06): POST
 * `suggestions/from-trace`, then on the 202 navigate to the agent's
 * Suggestions tab with `?suggesting=<id>` so the tab can show its
 * "Working on a suggestion…" skeleton until `suggestion.new` lands the
 * record. Rejects with the server's `RuntimeApiError` - callers toast
 * `error.message` (the 422 file-instructions case included).
 */
export function useSuggestFix(): (agentId: string, traceId: string) => Promise<void> {
  return useCallback(async (agentId: string, traceId: string) => {
    const { suggestionId } = await runtimeClient.suggestFromTrace(agentId, traceId);
    navigate(`/agents/${encodeURIComponent(agentId)}/suggestions?suggesting=${encodeURIComponent(suggestionId)}`);
  }, []);
}
