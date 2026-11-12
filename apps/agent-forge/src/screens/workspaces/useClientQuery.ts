// fallow-ignore-file code-duplication -- intentionally the useAgentRecord load shape (ticket P2.5 step 3).
import { useCallback, useEffect, useRef, useState } from 'react';
import { WorkspaceApiError, type ApiClient } from 'lousho/workspaces/client';
import { useWorkspacesClient } from './workspacesClient';

export interface QueryState<T> {
  data: T | undefined;
  loading: boolean;
  error: string | undefined;
  notFound: boolean;
  refresh(): void;
}

export function useClientQuery<T>(load: (client: ApiClient) => Promise<T>, key: string): QueryState<T> {
  const client = useWorkspacesClient();
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notFound, setNotFound] = useState(false);
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const keyRef = useRef(key);

  useEffect(() => {
    let cancelled = false;
    if (keyRef.current !== key) {
      keyRef.current = key;
      setData(undefined);
    }
    setLoading(true);
    setNotFound(false);
    setError(undefined);
    loadRef
      .current(client)
      .then((next) => {
        if (cancelled) return;
        setData(next);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof WorkspaceApiError && err.status === 404) setNotFound(true);
        else setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, key, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, notFound, refresh };
}
