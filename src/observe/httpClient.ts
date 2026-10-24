/**
 * One JSON call against the observe daemon, shared by the agent-side
 * clients (hub, prompt): `fetch` with the bearer header when a token is
 * set, a hard `timeoutMs` cap, and a non-2xx answer thrown as
 * `LOUSHO_REMOTE_REQUEST_FAILED` carrying the daemon's `{ error }` message.
 */

import { SDKError } from '../execution/errors';

/** Options of {@link observeRequest}. */
export interface ObserveRequestOptions {
  /** Bearer token for a `--require-token` daemon (`LOUSHO_OBSERVE_TOKEN`). */
  token?: string;
  /** Injectable transport (tests); default the global `fetch`. */
  fetchFn?: typeof fetch;
}

/** One `fetch` against the daemon as described above; resolves with the parsed JSON body. */
export async function observeRequest<T>(
  baseUrl: string,
  path: string,
  init: RequestInit,
  timeoutMs: number,
  options: ObserveRequestOptions = {}
): Promise<T> {
  const res = await (options.fetchFn ?? fetch)(`${baseUrl.replace(/\/+$/, '')}${path}`, {
    ...init,
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await res.json().catch(() => undefined)) as ({ error?: string } & T) | undefined;
  if (!res.ok) {
    throw new SDKError(
      `The observe daemon answered ${res.status} for ${path}: ${body?.error ?? res.statusText}.`,
      'LOUSHO_REMOTE_REQUEST_FAILED',
      { appendHelp: false }
    );
  }
  return body as T;
}
