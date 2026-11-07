import { useCallback, useEffect, useState } from 'react';

import type { AgentRecord } from '../../../shared/wireTypes';
import { RuntimeApiError, runtimeClient } from '../../runtime/runtimeClient';

/** What {@link useAgentRecord} reports while (and after) one agent's record loads. */
export interface AgentRecordState {
  /** The loaded record; `undefined` while loading, when not found, or after an error. */
  record: AgentRecord | undefined;
  /** A fetch is in flight. */
  loading: boolean;
  /** The agent does not exist (a 404). */
  notFound: boolean;
  /** The fetch's error message, when it failed for another reason. */
  error: string | undefined;
  /** Re-runs the fetch (the error state's Retry). */
  refresh(): void;
  /** Replaces the record in place - a tab's save shows without a refetch. */
  setRecord(next: AgentRecord): void;
}

/**
 * Loads `GET /agents/:id`'s `AgentRecord` for the detail screen, refetching
 * when `id` changes. A 404 (`loadAgent` answers `undefined`, or throws a
 * `RuntimeApiError` with status 404) is `notFound`, any other failure is
 * `error`.
 */
export function useAgentRecord(id: string): AgentRecordState {
  const [record, setRecordState] = useState<AgentRecord | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    setError(undefined);
    setRecordState(undefined);
    runtimeClient
      .loadAgent(id)
      .then((next) => {
        if (cancelled) return;
        if (next === undefined) setNotFound(true);
        else setRecordState(next);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof RuntimeApiError && err.status === 404) setNotFound(true);
        else setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const setRecord = useCallback((next: AgentRecord) => {
    setRecordState(next);
    setNotFound(false);
    setError(undefined);
    setLoading(false);
  }, []);

  return { record, loading, notFound, error, refresh, setRecord };
}
