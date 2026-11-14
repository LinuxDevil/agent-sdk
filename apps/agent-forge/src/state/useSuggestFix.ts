import { useCallback } from 'react';

import { runtimeClient } from '../runtime/runtimeClient';
import { navigate } from '../router/router';
import { agentTabPath } from '../screens/agents/agentTabs';

/**
 * The "Suggest a fix" action every surface shares (R06): POST
 * `suggestions/from-trace`, then on the 202 navigate to the agent's
 * Suggestions tab with `?suggesting=<id>` so the tab can show its
 * "Working on a suggestion…" skeleton until `suggestion.new` lands the
 * record. Rejects with the server's `RuntimeApiError` - callers toast
 * `error.message` (the 422 file-instructions case included). `ws` pins
 * the request and the link to a workspace (W09b's all-inbox rows); with
 * none, the URL's active workspace is used.
 */
export function useSuggestFix(): (agentId: string, traceId: string, ws?: string) => Promise<void> {
  return useCallback(async (agentId: string, traceId: string, ws?: string) => {
    const client = ws === undefined ? runtimeClient : runtimeClient.forWorkspace(ws);
    const { suggestionId } = await client.suggestFromTrace(agentId, traceId);
    navigate(`${agentTabPath(agentId, 'suggestions', ws)}?suggesting=${encodeURIComponent(suggestionId)}`);
  }, []);
}
