import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

import { errorMessage } from '../components/errorMessage';

export interface FetchedResource<T> {
  value: T | undefined;
  error: string | undefined;
  loading: boolean;
  refresh(): Promise<void>;
  /** In-place patch escape hatch (e.g. filling one row's summary without a refetch). */
  setValue: Dispatch<SetStateAction<T | undefined>>;
}

/**
 * The fetch-on-key-change + live-refresh skeleton the agent-detail data
 * hooks share (L11b's useDraftView/useVersions/usePendingDraftCount were
 * three copies of it - fallow's clone gate): `fetch(key)` runs on mount,
 * whenever `key` changes and on every `refresh()`; a request counter drops
 * stale responses so a slow earlier fetch cannot overwrite a newer one.
 * `key === undefined` resolves `value` to `undefined` without a request.
 * `fetch` is read through a ref so an inline closure cannot retrigger the
 * effect every render.
 */
export function useFetchedResource<T>(options: {
  key: string | undefined;
  fetch: (key: string) => Promise<T>;
}): FetchedResource<T> {
  const { key } = options;
  const fetchRef = useRef(options.fetch);
  useEffect(() => {
    fetchRef.current = options.fetch;
  });
  const [value, setValue] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    if (key === undefined) {
      setValue(undefined);
      setError(undefined);
      setLoading(false);
      return;
    }
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const next = await fetchRef.current(key);
      if (request !== requestRef.current) return;
      setValue(next);
      setError(undefined);
    } catch (err) {
      if (request !== requestRef.current) return;
      setError(errorMessage(err));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { value, error, loading, refresh, setValue };
}
