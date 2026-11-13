import { useCallback, useEffect, useRef, useState } from 'react';

import { runtimeClient } from '../../runtime/runtimeClient';
import { useStudioEvents } from '../../state/useStudioEvents';
import type { InboxItem, StudioEvent } from '../../../shared/wireTypes';

type InboxLoadState = 'loading' | 'ready' | 'error';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : 'Request failed');

const hasDeadline = (item: InboxItem) =>
  (item.kind === 'approval' || item.kind === 'question') && item.expiresAt !== null;

/**
 * The inbox list plus its refresh wiring (R02b): fetches on mount and on
 * every `inbox.count` event, and runs a shared 1s clock only while a
 * deadline-bearing row is on screen.
 */
export function useInboxData() {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [state, setState] = useState<InboxLoadState>('loading');
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const list = await runtimeClient.listInbox();
      if (request !== requestRef.current) return;
      setItems(list);
      setState('ready');
      setError('');
    } catch (cause) {
      if (request !== requestRef.current) return;
      setError(errorMessage(cause));
      setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useStudioEvents(
    useCallback(
      (event: StudioEvent) => {
        if (event.type === 'inbox.count') void load();
      },
      [load],
    ),
  );

  const ticking = items?.some(hasDeadline) ?? false;
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  return { items, setItems, state, error, now, refresh: load };
}
