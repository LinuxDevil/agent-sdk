import { useCallback, useEffect, useRef, useState } from 'react';

import { runtimeClient } from '../runtime/runtimeClient';
import { useStudioEvents } from './useStudioEvents';
import type { StudioEvent } from '../../shared/wireTypes';

/** `agent.changed` reasons that can create or remove the agent's pending draft. */
const AGENT_CHANGED_REASONS = new Set<Extract<StudioEvent, { type: 'agent.changed' }>['reason']>([
  'version',
  'restore',
  'save',
]);

/**
 * The Suggestions tab badge (L11b): `1` while the agent has a pending
 * `ChangeDraft`, `0` otherwise - `undefined` `agentId` (an unsaved
 * agent) reads as `0` without a request. Refreshed by the shared
 * `/events` socket on `draft.changed` and on spec-moving `agent.changed`
 * reasons; a request counter drops stale responses.
 */
export function usePendingDraftCount(agentId: string | undefined): number {
  const [count, setCount] = useState(0);
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    if (agentId === undefined) {
      setCount(0);
      return;
    }
    const request = ++requestRef.current;
    try {
      const draft = await runtimeClient.getDraft(agentId);
      if (request !== requestRef.current) return;
      setCount(draft === undefined ? 0 : 1);
    } catch {
      if (request === requestRef.current) setCount(0);
    }
  }, [agentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useStudioEvents(
    useCallback(
      (event: StudioEvent) => {
        if (agentId === undefined) return;
        if (event.type === 'draft.changed') {
          if (event.agentId === agentId) void refresh();
        } else if (
          event.type === 'agent.changed' &&
          event.agentId === agentId &&
          AGENT_CHANGED_REASONS.has(event.reason)
        ) {
          void refresh();
        }
      },
      [agentId, refresh],
    ),
  );

  return count;
}
