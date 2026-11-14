import { useEffect, useState } from 'react';

import { runtimeClient } from '../runtime/runtimeClient';
import { useAllStudioEvents } from './useStudioEvents';
import type { AllEventsFrame } from '../../shared/wireTypes';

/**
 * The nav rail's Inbox badge (R02b, Studio-wide since W09b): the server's
 * `GET /inbox/count?ws=all` on mount, then every aggregate `inbox.count`
 * frame (`workspaceId: 'all'`) replaces it - the frame already carries the
 * new total, so no refetch. A dropped socket changes nothing: the next
 * frame or remount resyncs.
 */
export function useInboxCount(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let live = true;
    runtimeClient
      .allInboxCount()
      .then((n) => {
        if (live) setCount(n);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  useAllStudioEvents((frame: AllEventsFrame) => {
    if (frame.type === 'inbox.count' && frame.workspaceId === 'all') setCount(frame.count);
  });

  return count;
}
