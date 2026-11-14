import { useCallback, useEffect, useRef, useState } from 'react';

import { runtimeClient } from '../../runtime/runtimeClient';
import { useStudioFrames, type StudioFrame } from '../../state/useStudioEvents';
import type { InboxItem } from '../../../shared/wireTypes';
import type { InboxScope } from './inboxScope';

type InboxLoadState = 'loading' | 'ready' | 'error';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : 'Request failed');

const hasDeadline = (item: InboxItem) =>
  (item.kind === 'approval' || item.kind === 'question') && item.expiresAt !== null;

/**
 * The inbox list plus its refresh wiring (R02b, scoped by W09b): the
 * all-workspaces view fetches `GET /inbox?ws=all` and follows
 * `WS /events?ws=all`; a `/w/<ws>/inbox` view fetches that workspace's
 * `/inbox` and follows its own `/events`. Either way the list refetches
 * on mount, on scope change, and on every `inbox.count` event, and runs a
 * shared 1s clock only while a deadline-bearing row is on screen.
 */
export function useInboxData(scope: InboxScope) {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [state, setState] = useState<InboxLoadState>('loading');
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const requestRef = useRef(0);
  const workspaceId = scope.kind === 'workspace' ? scope.workspaceId : undefined;

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const list =
        workspaceId === undefined ? await runtimeClient.listAllInbox() : await runtimeClient.forWorkspace(workspaceId).listInbox();
      if (request !== requestRef.current) return;
      setItems(list);
      setState('ready');
      setError('');
    } catch (cause) {
      if (request !== requestRef.current) return;
      setError(errorMessage(cause));
      setState('error');
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  useStudioFrames(
    workspaceId === undefined,
    useCallback(
      (frame: StudioFrame) => {
        if (frame.type === 'inbox.count') void load();
      },
      [load],
    )
  );

  const ticking = items?.some(hasDeadline) ?? false;
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  return { items, setItems, state, error, now, refresh: load };
}
