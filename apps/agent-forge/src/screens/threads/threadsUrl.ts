/**
 * The Threads list's filter state, held entirely in the `#/threads?...` query.
 *
 * Keys: `agent` (agent_id), `status` (session status), `from` + `to` (an
 * absolute half-open window over the session's start, ms epoch) and `offset`
 * (paging). As on Traces, the time range has one URL representation: the
 * default rolling window (30d - threads are long-lived) writes nothing, and
 * any other preset is snapshotted to absolute bounds when picked. Defaults are
 * never written, so a bare `#/threads` stays bare.
 */
import type { SessionListFilter } from '../../observe/observeClient';
import { parseWindow, toInt, writeWindow } from '../urlState';

/** Rows per page, requested from the daemon (`limit`). */
export const THREADS_PAGE_SIZE = 50;
/** The picker preset an empty URL means. */
export const DEFAULT_THREADS_RANGE = '30d';
const DEFAULT_WINDOW_MS = 2_592_000_000;

/** The parsed `#/threads` query; absent fields are the defaults. */
export interface ThreadsUrlState {
  agent?: string;
  status?: string;
  window?: { from: number; to: number };
  offset: number;
}

/** Read the list state from a `#/threads` query; malformed values fall back to the defaults. */
export function parseThreadsQuery(query: URLSearchParams): ThreadsUrlState {
  const state: ThreadsUrlState = { offset: toInt(query.get('offset')) ?? 0 };
  const agent = query.get('agent');
  const status = query.get('status');
  if (agent) state.agent = agent;
  if (status) state.status = status;
  const window = parseWindow(query);
  if (window) state.window = window;
  return state;
}

/** The query string (`''` or `?a=b...`) for a list state, leaving every default out. */
export function formatThreadsQuery(state: ThreadsUrlState): string {
  const params = new URLSearchParams();
  if (state.agent) params.set('agent', state.agent);
  if (state.status) params.set('status', state.status);
  writeWindow(params, state.window);
  if (state.offset > 0) params.set('offset', String(state.offset));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/** The daemon filter for a list state; `now` resolves the default rolling window. */
export function toSessionFilter(state: ThreadsUrlState, now: number): SessionListFilter {
  const window = state.window ?? { from: now - DEFAULT_WINDOW_MS, to: now };
  return {
    agent_id: state.agent,
    status: state.status,
    from: window.from,
    to: window.to,
    limit: THREADS_PAGE_SIZE,
    offset: state.offset,
  };
}

let lastListQuery = '';

/** Remember the list's query string so a thread's "Back to threads" returns to the same filters. */
export function rememberThreadsQuery(query: string): void {
  lastListQuery = query;
}

/** `/threads` plus the last list query seen this session (bare when none). */
export function threadsListPath(): string {
  return `/threads${lastListQuery}`;
}
