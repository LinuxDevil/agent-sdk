import { useCallback, useEffect, useRef, useState } from 'react';
import { runtimeClient } from '../runtime/runtimeClient';
import type { HostStatus } from '../../shared/wireTypes';

/** What `useHostStatus` hands a screen: the last status, the restart action, and its busy/error state. */
export interface HostStatusState {
  /** The latest `HostStatus`; `undefined` until the first GET or event lands. */
  status: HostStatus | undefined;
  /** `true` while `POST /workspaces/:ws/host/restart` is in flight. */
  restarting: boolean;
  /** The restart failure's server message, cleared on the next attempt/success. */
  restartError: string | undefined;
  /** Restarts the workspace's project bridge; resolves with the settled status. */
  restart(): Promise<void>;
}

/**
 * W11c: one workspace's host status - `GET /workspaces/:ws/host` once,
 * then the `host.status` events that workspace's bus publishes (banner
 * settles and bridge crashes alike). The socket binds `?ws=<id>` through
 * `forWorkspace`, so events from other workspaces never land here.
 */
export function useHostStatus(workspaceId: string | undefined): HostStatusState {
  const [status, setStatus] = useState<HostStatus | undefined>(undefined);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | undefined>(undefined);
  // The latest workspace id, so an in-flight GET/restart for a previous
  // workspace cannot write over the new one's state.
  const wsRef = useRef(workspaceId);
  wsRef.current = workspaceId;

  useEffect(() => {
    setStatus(undefined);
    setRestartError(undefined);
    if (workspaceId === undefined) return undefined;
    let cancelled = false;
    const apply = (next: HostStatus): void => {
      if (!cancelled && next.workspaceId === wsRef.current) setStatus(next);
    };
    void runtimeClient
      .hostStatus(workspaceId)
      .then(apply)
      .catch(() => undefined);
    const bound = runtimeClient.forWorkspace(workspaceId);
    const unsubscribe = bound.subscribeEvents(
      (event) => {
        if (event.type === 'host.status') apply(event.payload);
      },
      {
        onLost: () => {
          // A dropped socket may have missed the settle that flipped the
          // banner - re-read the REST status rather than guess.
          void bound
            .hostStatus(workspaceId)
            .then(apply)
            .catch(() => undefined);
        },
      }
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [workspaceId]);

  const restart = useCallback(async () => {
    if (workspaceId === undefined) return;
    setRestarting(true);
    setRestartError(undefined);
    try {
      const next = await runtimeClient.restartHost(workspaceId);
      if (wsRef.current === workspaceId) setStatus(next);
    } catch (error) {
      if (wsRef.current === workspaceId) setRestartError(error instanceof Error ? error.message : String(error));
    } finally {
      setRestarting(false);
    }
  }, [workspaceId]);

  return { status, restarting, restartError, restart };
}

/**
 * The banner text a read-only workspace's Run/save controls disable with
 * (`undefined` for every other mode) - shared by the screens so the
 * `?.`/`?:` branches live here, not in each component.
 */
export function hostReadOnlyTitle(status: HostStatus | undefined): string | undefined {
  return status?.mode === 'read-only' ? status.banner?.text : undefined;
}
