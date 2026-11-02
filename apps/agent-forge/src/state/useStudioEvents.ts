import { useEffect, useRef, useState } from 'react';
import { runtimeClient } from '../runtime/runtimeClient';
import type { StudioEvent } from '../../shared/wireTypes';

/** How long to wait before re-opening a dropped `/events` socket - same as useAgentStream's stream reconnect. */
const RECONNECT_DELAY_MS = 2000;

/**
 * One `WS /events` subscription for the whole app: `onEvent` sees every
 * `StudioEvent` the server publishes. The socket reconnects
 * `RECONNECT_DELAY_MS` after it drops (the same pattern
 * `useAgentStream` uses for `/agents/:id/stream`); a missed event only
 * means a stale list until the next one - the REST reads it refreshes
 * stay the source of truth.
 *
 * `onEvent` may be a fresh closure each render - the subscription is
 * opened once and always calls the latest callback rather than
 * re-subscribing when its identity changes.
 */
export function useStudioEvents(onEvent: (event: StudioEvent) => void): void {
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  });
  // `attempt` bumps on each socket loss so the effect re-subscribes.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let retry: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = runtimeClient.subscribeEvents((event) => onEventRef.current(event), {
      onLost: () => {
        retry = setTimeout(() => setAttempt((n) => n + 1), RECONNECT_DELAY_MS);
      },
    });
    return () => {
      if (retry) clearTimeout(retry);
      unsubscribe();
    };
  }, [attempt]);
}
