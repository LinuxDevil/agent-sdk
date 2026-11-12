import { useCallback } from 'react';

import { useStudioEvents } from './useStudioEvents';
import type { StudioEvent } from '../../shared/wireTypes';

/** `agent.changed` reasons that can create, move or remove the agent's pending draft. */
const DRAFT_AGENT_CHANGED_REASONS = new Set<Extract<StudioEvent, { type: 'agent.changed' }>['reason']>([
  'version',
  'restore',
  'save',
]);

/**
 * The `/events` subscription every pending-draft reader shares (L11b):
 * `refresh()` on this agent's `draft.changed` and on spec-moving
 * `agent.changed` reasons. `agentId === undefined` subscribes but never
 * matches (an unsaved agent has no draft to watch).
 */
export function useDraftRefreshEvents(agentId: string | undefined, refresh: () => Promise<void>): void {
  useStudioEvents(
    useCallback(
      (event: StudioEvent) => {
        if (agentId === undefined) return;
        const draftMoved =
          (event.type === 'draft.changed' && event.agentId === agentId) ||
          (event.type === 'agent.changed' && event.agentId === agentId && DRAFT_AGENT_CHANGED_REASONS.has(event.reason));
        if (draftMoved) void refresh();
      },
      [agentId, refresh],
    ),
  );
}
