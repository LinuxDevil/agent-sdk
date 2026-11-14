import { useEffect, useRef, useState } from 'react';
import { runtimeClient } from '../runtime/runtimeClient';
import type { AllEventsFrame, StudioEvent } from '../../shared/wireTypes';

/** How long to wait before re-opening a dropped `/events` socket - same as useAgentStream's stream reconnect. */
const RECONNECT_DELAY_MS = 2000;

/** Any frame either `/events` socket delivers: a bare `StudioEvent`, or the aggregate's workspace-tagged `AllEventsFrame`. */
export type StudioFrame = StudioEvent | AllEventsFrame;

type Subscribe<T> = (onFrame: (frame: T) => void, onLost: () => void) => () => void;

const subscribeWorkspaceEvents: Subscribe<StudioEvent> = (onFrame, onLost) =>
  runtimeClient.subscribeEvents(onFrame, { onLost });
const subscribeAllEvents: Subscribe<AllEventsFrame> = (onFrame, onLost) =>
  runtimeClient.subscribeAllEvents(onFrame, { onLost });
// Widened variants for `useStudioFrames`, whose callback takes the union.
const subscribeWorkspaceFrames: Subscribe<StudioFrame> = (onFrame, onLost) =>
  runtimeClient.subscribeEvents((event) => onFrame(event), { onLost });
const subscribeAllFrames: Subscribe<StudioFrame> = (onFrame, onLost) =>
  runtimeClient.subscribeAllEvents((frame) => onFrame(frame), { onLost });

/**
 * The shared socket loop behind the `use*Events` hooks: subscribes once,
 * always calls the latest `onFrame`, and re-opens `RECONNECT_DELAY_MS`
 * after a drop (the same pattern `useAgentStream` uses for
 * `/agents/:id/stream`). A missed event only means a stale list until the
 * next one - the REST reads it refreshes stay the source of truth.
 */
function useEventSubscription<T>(subscribe: Subscribe<T>, onFrame: (frame: T) => void): void {
  const onFrameRef = useRef(onFrame);
  useEffect(() => {
    onFrameRef.current = onFrame;
  });
  // `attempt` bumps on each socket loss so the effect re-subscribes.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let retry: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribe(
      (frame) => onFrameRef.current(frame),
      () => {
        retry = setTimeout(() => setAttempt((n) => n + 1), RECONNECT_DELAY_MS);
      }
    );
    return () => {
      if (retry) clearTimeout(retry);
      unsubscribe();
    };
  }, [subscribe, attempt]);
}

/**
 * One `WS /events` subscription for the whole app: `onEvent` sees every
 * `StudioEvent` the server publishes on the active workspace's bus.
 */
export function useStudioEvents(onEvent: (event: StudioEvent) => void): void {
  useEventSubscription(subscribeWorkspaceEvents, onEvent);
}

/**
 * One `WS /events?ws=all` subscription (W09a/W09b): `onFrame` sees every
 * workspace's `StudioEvent` tagged with its `workspaceId`, plus the
 * Studio-wide `{ type: 'inbox.count', workspaceId: 'all' }` total.
 */
export function useAllStudioEvents(onFrame: (frame: AllEventsFrame) => void): void {
  useEventSubscription(subscribeAllEvents, onFrame);
}

/**
 * The scope-aware variant (W09b): `all` follows `WS /events?ws=all`,
 * otherwise the active workspace's `WS /events`. Flipping `all`
 * re-subscribes; `onFrame` sees whichever socket's frames.
 */
export function useStudioFrames(all: boolean, onFrame: (frame: StudioFrame) => void): void {
  useEventSubscription(all ? subscribeAllFrames : subscribeWorkspaceFrames, onFrame);
}
