import { useEffect, useState } from 'react';

import { runtimeClient } from '../runtime/runtimeClient';
import { useStudioEvents } from './useStudioEvents';
import type { StudioEvent } from '../../shared/wireTypes';

/**
 * The nav rail's Inbox badge (R02b): the server's `GET /inbox/count` on
 * mount, then every `inbox.count` StudioEvent replaces it - the event
 * already carries the new count, so no refetch. A dropped socket changes
 * nothing: the next event or remount resyncs.
 */
export function useInboxCount(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let live = true;
    runtimeClient
      .inboxCount()
      .then(({ count: n }) => {
        if (live) setCount(n);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  useStudioEvents((event: StudioEvent) => {
    if (event.type === 'inbox.count') setCount(event.count);
  });

  return count;
}
