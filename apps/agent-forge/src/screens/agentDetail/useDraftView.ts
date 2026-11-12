import { useCallback, useEffect, useRef, useState } from 'react';

import { errorMessage } from '../../components/errorMessage';
import { runtimeClient } from '../../runtime/runtimeClient';
import { useStudioEvents } from '../../state/useStudioEvents';
import type { DraftView, StudioEvent } from '../../../shared/wireTypes';

/** `agent.changed` reasons that can move the draft's diff or drift banner. */
const AGENT_CHANGED_REASONS = new Set<Extract<StudioEvent, { type: 'agent.changed' }>['reason']>([
  'version',
  'restore',
  'save',
]);

/**
 * The Suggestions tab's draft (L11b): `GET /agents/:id/draft` on mount and
 * whenever `agentId` changes, refreshed live by the shared `/events`
 * socket - every `draft.changed` for the agent (create, restate, the
 * review pass's write-backs, approve/reject/withdraw) and an
 * `agent.changed` with a spec-moving reason re-fetch the `DraftView`.
 * A request counter drops stale responses so a slow earlier fetch
 * cannot overwrite a newer one.
 */
export function useDraftView(agentId: string): {
  draft: DraftView | undefined;
  error: string | undefined;
  loading: boolean;
  refresh(): Promise<void>;
} {
  const [draft, setDraft] = useState<DraftView | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const view = await runtimeClient.getDraft(agentId);
      if (request !== requestRef.current) return;
      setDraft(view);
      setError(undefined);
    } catch (err) {
      if (request !== requestRef.current) return;
      setError(errorMessage(err));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useStudioEvents(
    useCallback(
      (event: StudioEvent) => {
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

  return { draft, error, loading, refresh };
}
