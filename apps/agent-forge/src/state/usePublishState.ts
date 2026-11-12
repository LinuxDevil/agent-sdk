import { useCallback, useEffect, useRef, useState } from 'react';

import type { PublishState, StudioEvent } from '../../shared/wireTypes';
import { runtimeClient } from '../runtime/runtimeClient';
import { useStudioEvents } from './useStudioEvents';

/** `agent.changed` reasons that can move the publish pointer or the working-copy hash it compares against. */
const PUBLISH_REASONS = new Set<Extract<StudioEvent, { type: 'agent.changed' }>['reason']>([
  'meta',
  'version',
  'save',
  'restore',
  'import',
]);

/**
 * The open agent's publish pointer (L14b): `GET /agents/:id`'s
 * `publishState`, refetched on mount/agent switch and on the shared
 * `/events` socket whenever an `agent.changed` for this agent carries a
 * reason that can move it (publish writes `meta`, an autosave `save`, a
 * restore `restore`, an import `import`). A request counter drops stale
 * responses; `undefined` until the first answer lands (or when the agent
 * is gone), so callers render nothing rather than a wrong pill.
 */
export function usePublishState(agentId: string): { state: PublishState | undefined; refresh(): Promise<void> } {
  const [state, setState] = useState<PublishState | undefined>(undefined);
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const record = await runtimeClient.loadAgent(agentId);
      if (request !== requestRef.current) return;
      setState(record?.publishState);
    } catch {
      if (request !== requestRef.current) return;
      setState(undefined);
    }
  }, [agentId]);

  useEffect(() => {
    setState(undefined);
    void refresh();
  }, [refresh]);

  useStudioEvents(
    useCallback(
      (event: StudioEvent) => {
        if (event.type !== 'agent.changed' || event.agentId !== agentId) return;
        if (PUBLISH_REASONS.has(event.reason)) void refresh();
      },
      [agentId, refresh],
    ),
  );

  return { state, refresh };
}
