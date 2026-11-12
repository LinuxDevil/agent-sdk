import { useCallback } from 'react';

import { runtimeClient } from '../../runtime/runtimeClient';
import { useFetchedResource } from '../../state/useFetchedResource';
import { useStudioEvents } from '../../state/useStudioEvents';
import type { PromptSuggestion, StudioEvent } from '../../../shared/wireTypes';

/** `agent.changed` reasons that can settle a suggestion (an apply writes a `version`). */
const SUGGESTION_AGENT_CHANGED_REASONS = new Set<Extract<StudioEvent, { type: 'agent.changed' }>['reason']>([
  'version',
]);

/**
 * The Suggestions tab's prompt-suggestion list (R06): `GET
 * /agents/:id/suggestions` on mount and agent change, live-refreshed on
 * this agent's `suggestion.new` (the pass finished) and spec-moving
 * `agent.changed` reasons. Portability analyses never appear (the server
 * filters them; `kind` is re-checked client side per the contract) and
 * `dismissed` records stay in the store but off the tab.
 */
export function useSuggestions(agentId: string): {
  suggestions: PromptSuggestion[];
  error: string | undefined;
  loading: boolean;
  refresh(): Promise<void>;
} {
  const { value, error, loading, refresh } = useFetchedResource<PromptSuggestion[]>({
    key: agentId,
    fetch: async (id) =>
      (await runtimeClient.listSuggestions(id)).filter(
        (item): item is PromptSuggestion => item.kind === 'prompt_edit' && item.status !== 'dismissed'
      ),
  });

  useStudioEvents(
    useCallback(
      (event: StudioEvent) => {
        if (event.type === 'suggestion.new' && event.agentId === agentId) void refresh();
        if (
          event.type === 'agent.changed' &&
          event.agentId === agentId &&
          SUGGESTION_AGENT_CHANGED_REASONS.has(event.reason)
        ) {
          void refresh();
        }
      },
      [agentId, refresh],
    ),
  );

  return { suggestions: value ?? [], error, loading, refresh };
}
