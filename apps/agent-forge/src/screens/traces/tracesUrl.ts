/**
 * The Traces list's filter state, held entirely in the `#/traces?...` query.
 *
 * Keys: `agent` (agent_id), `status`, `model`, `project`, `q`, `prompt`
 * (`<name>` or `<name>@<version>`, the Prompts screen's runs link), `from` + `to`
 * (an absolute half-open window in ms epoch), `sort` (duration|tokens|cost|start)
 * + `order` (asc|desc), and `offset` (paging). The time range has ONE URL
 * representation, `from`/`to`: the default rolling 24h window writes nothing,
 * and any other preset is snapshotted to absolute bounds when picked, so a
 * reload shows exactly the same rows. Defaults (24h, start desc, offset 0) are
 * never written, so a bare `#/traces` stays bare.
 */
import type { TraceListFilter, TraceSort } from '../../observe/observeClient';
import { parseWindow, toInt, writeWindow } from '../urlState';

/** Rows per page, requested from the daemon (`limit`). */
export const PAGE_SIZE = 50;
/** The default rolling window when the URL has no `from`/`to`. */
const DEFAULT_WINDOW_MS = 86_400_000;

const SORTS: readonly TraceSort[] = ['start', 'duration', 'tokens', 'cost'];
/** Text filters, in the order they are written to the URL. */
const TEXT_KEYS = ['agent', 'status', 'model', 'project', 'q', 'prompt'] as const;
type TextKey = (typeof TEXT_KEYS)[number];

/** The parsed `#/traces` query; absent fields are the defaults. */
export type TracesUrlState = Partial<Record<TextKey, string>> & {
  window?: { from: number; to: number };
  sort?: { key: TraceSort; order: 'asc' | 'desc' };
  offset: number;
};

function parseSort(query: URLSearchParams): TracesUrlState['sort'] {
  const key = query.get('sort') as TraceSort | null;
  if (key === null || !SORTS.includes(key)) return undefined;
  return { key, order: query.get('order') === 'asc' ? 'asc' : 'desc' };
}

/** Read the list state from a `#/traces` query; unknown or malformed values fall back to the defaults. */
export function parseTracesQuery(query: URLSearchParams): TracesUrlState {
  const state: TracesUrlState = { offset: toInt(query.get('offset')) ?? 0 };
  for (const key of TEXT_KEYS) {
    const value = query.get(key);
    if (value) state[key] = value;
  }
  state.window = parseWindow(query);
  state.sort = parseSort(query);
  return state;
}

/** The query string (`''` or `?a=b...`) for a list state, leaving every default out. */
export function formatTracesQuery(state: TracesUrlState): string {
  const params = new URLSearchParams();
  for (const key of TEXT_KEYS) if (state[key]) params.set(key, state[key]!);
  writeWindow(params, state.window);
  const { sort } = state;
  if (sort && !(sort.key === 'start' && sort.order === 'desc')) {
    params.set('sort', sort.key);
    params.set('order', sort.order);
  }
  if (state.offset > 0) params.set('offset', String(state.offset));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/** The daemon filter for a list state; `now` resolves the default rolling window. */
export function toTraceFilter(state: TracesUrlState, now: number): TraceListFilter {
  const window = state.window ?? { from: now - DEFAULT_WINDOW_MS, to: now };
  return {
    agent_id: state.agent,
    status: state.status,
    model: state.model,
    project: state.project,
    q: state.q,
    prompt: state.prompt,
    from: window.from,
    to: window.to,
    sort: state.sort?.key,
    order: state.sort?.order,
    limit: PAGE_SIZE,
    offset: state.offset,
  };
}

let lastListQuery = '';

/** Remember the list's query string so the trace detail's Back returns to the same filters. */
export function rememberListQuery(query: string): void {
  lastListQuery = query;
}

/** `#/traces` plus the last list query seen this session (bare when none). */
export function tracesListPath(): string {
  return `/traces${lastListQuery}`;
}
