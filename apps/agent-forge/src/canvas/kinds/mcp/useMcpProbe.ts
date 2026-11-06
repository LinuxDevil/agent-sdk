/**
 * `useMcpProbe(server)` drives the MCP Inspector's Probe button: `probe()`
 * posts the server to `POST /catalog/mcp/probe` through
 * `runtimeClient.probeMcp` and the hook answers `idle | probing | done |
 * error` plus the tools (or the failure) it got back. Results are cached in
 * a module `Map` keyed by `JSON.stringify(server)` for the page session —
 * not persisted, and editing the server changes the key, so a fixed config
 * always gets a fresh probe.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../../components/errorMessage';
import { runtimeClient } from '../../../runtime/runtimeClient';
import type { McpProbeResponse, McpProbeTool } from '../../../../shared/wireTypes';
import type { McpServerSpec } from '../../../graph/v2/specTypes';

/** The probe lifecycle the Inspector renders. */
export type McpProbeState = 'idle' | 'probing' | 'done' | 'error';

/** What {@link useMcpProbe} answers. */
export interface McpProbe {
  state: McpProbeState;
  /** The server's advertised tools (empty until a probe succeeds). */
  tools: McpProbeTool[];
  /** Why the probe failed (a `ok: false` response or a thrown request). */
  error: string | undefined;
  /** Starts the probe (or re-applies the cached result). */
  probe(): void;
}

/** In-flight probes settle into the same map entry, so a second caller — or a remount — shares the result. */
const probeCache = new Map<string, Promise<McpProbeResponse> | McpProbeResponse>();

interface LocalResult {
  state: McpProbeState;
  tools: McpProbeTool[];
  error: string | undefined;
}

const IDLE: LocalResult = { state: 'idle', tools: [], error: undefined };
const PROBING: LocalResult = { state: 'probing', tools: [], error: undefined };

/** `response` as a `LocalResult`. */
function toResult(response: McpProbeResponse): LocalResult {
  return response.ok
    ? { state: 'done', tools: response.tools, error: undefined }
    : { state: 'error', tools: [], error: response.error };
}

/** A cached entry's settled result, or `undefined` while it is still in flight. */
function cached(key: string): LocalResult | undefined {
  const entry = probeCache.get(key);
  return entry !== undefined && !(entry instanceof Promise) ? toResult(entry) : undefined;
}

/**
 * The probe result for `server`: cached per `JSON.stringify(server)` for
 * the page session, so a second `probe()` of the same server — and a probe
 * the card already ran — never repeats the request.
 */
export function useMcpProbe(server: McpServerSpec): McpProbe {
  const key = JSON.stringify(server);
  const keyRef = useRef(key);
  keyRef.current = key;
  const [result, setResult] = useState<LocalResult>(() => cached(key) ?? IDLE);

  // A server edit re-keys the cache: show the settled result when one is
  // cached, follow an in-flight probe, else reset to idle.
  useEffect(() => {
    const entry = probeCache.get(key);
    if (entry === undefined) {
      setResult(IDLE);
    } else if (entry instanceof Promise) {
      setResult(PROBING);
      settle(key, entry, setResult, keyRef);
    } else {
      setResult(toResult(entry));
    }
  }, [key]);

  const probe = useCallback(() => {
    const entry = probeCache.get(key);
    if (entry !== undefined && !(entry instanceof Promise)) {
      setResult(toResult(entry));
      return;
    }
    setResult(PROBING);
    const promise = entry ?? runtimeClient.probeMcp(server);
    if (entry === undefined) probeCache.set(key, promise);
    settle(key, promise, setResult, keyRef);
  }, [key, server]);

  return { state: result.state, tools: result.tools, error: result.error, probe };
}

/** Applies `promise`'s settlement to the cache and — while `key` is still current — to `setResult`. */
function settle(
  key: string,
  promise: Promise<McpProbeResponse>,
  setResult: (result: LocalResult) => void,
  keyRef: { current: string },
): void {
  promise.then(
    (response) => {
      probeCache.set(key, response);
      if (keyRef.current === key) setResult(toResult(response));
    },
    (error) => {
      // A thrown request is not cached — the user can retry it.
      if (probeCache.get(key) === promise) probeCache.delete(key);
      if (keyRef.current === key) {
        setResult({ state: 'error', tools: [], error: errorMessage(error) });
      }
    },
  );
}
