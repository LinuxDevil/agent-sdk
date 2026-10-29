/**
 * The Evaluators screen's URL state, plus the pure helpers its views share.
 *
 * - `#/evals/evaluators[?kind=&enabled=&offset=]` - the rule list. `kind` is
 *   `code` or `judge`, `enabled` is `true` or `false`, `offset` pages
 *   server-side; a missing key means "any" (or page one) and defaults are
 *   never written.
 * - `#/evals/evaluators/:id[?trace=]` - the edit view for one rule (`:id` is
 *   the URL-encoded `rule_id`); `?trace=` prefills "Test on trace". The list's
 *   filters ride along so "All evaluators" returns to the same list.
 */
import type { ObserveEvaluatorFilter, ObserveScoreRow } from '../../observe/types';
import { toInt } from '../urlState';

/** Rules per list page, requested from the daemon (`limit`). */
export const EVALUATORS_PAGE_SIZE = 50;

/** Online scores read (newest first, one request) to fill the list's "Last run" and "Runs (24h)" columns. */
export const ONLINE_SCORES_CAP = 1000;

const DAY_MS = 86_400_000;

/** The list's URL filters; `undefined` is "any". */
export interface EvaluatorListState {
  kind?: 'code' | 'judge';
  enabled?: boolean;
  offset: number;
}

/** The list state a hash query holds; unknown values read as "any". */
export function parseListState(query: URLSearchParams): EvaluatorListState {
  const kind = query.get('kind');
  const enabled = query.get('enabled');
  return {
    kind: kind === 'code' || kind === 'judge' ? kind : undefined,
    enabled: enabled === 'true' ? true : enabled === 'false' ? false : undefined,
    offset: toInt(query.get('offset')) ?? 0,
  };
}

/** The list's query string (with its `?`), defaults left out. */
function listQuery(state: EvaluatorListState): string {
  const params = new URLSearchParams();
  if (state.kind) params.set('kind', state.kind);
  if (state.enabled !== undefined) params.set('enabled', String(state.enabled));
  if (state.offset) params.set('offset', String(state.offset));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/** The hash path of the rule list. */
export const evaluatorsPath = (state: EvaluatorListState = { offset: 0 }): string => `/evals/evaluators${listQuery(state)}`;

/** The hash path of one rule's edit view, carrying the list's filters (`state`) for its way back. */
export const evaluatorPath = (ruleId: string, state: EvaluatorListState = { offset: 0 }): string =>
  `/evals/evaluators/${encodeURIComponent(ruleId)}${listQuery(state)}`;

/** A rule's filter in a few words: `agent=…, status=…, name~…`, or "All traces". */
export function filterSummary(filter: ObserveEvaluatorFilter): string {
  const parts: string[] = [];
  if (filter.agent_id) parts.push(`agent=${filter.agent_id}`);
  if (filter.status) parts.push(`status=${filter.status}`);
  if (filter.name_contains) parts.push(`name~${filter.name_contains}`);
  return parts.length ? parts.join(', ') : 'All traces';
}

/** What the list shows per rule from its online scores. */
export interface RuleRuns {
  /** The newest score's `created_at` (epoch ms). */
  lastRun: number;
  /** Scores created in the 24 hours before `now`. */
  runs24h: number;
}

/**
 * Online scores (`source: "online"`, newest first) grouped by name - each
 * rule writes its scores under its own name. Scores of other sources are
 * ignored. Only what `scores` holds is counted, so a capped read is a floor.
 */
export function groupOnlineRuns(scores: readonly ObserveScoreRow[], now: number): Map<string, RuleRuns> {
  const runs = new Map<string, RuleRuns>();
  for (const score of scores) {
    if (score.source !== 'online') continue;
    const entry = runs.get(score.name) ?? { lastRun: score.created_at, runs24h: 0 };
    entry.lastRun = Math.max(entry.lastRun, score.created_at);
    if (score.created_at > now - DAY_MS && score.created_at <= now) entry.runs24h += 1;
    runs.set(score.name, entry);
  }
  return runs;
}

/** True when a capped read may have missed some of the last day's scores (it is full and its oldest row is inside the day). */
export function runsCapped(scores: readonly ObserveScoreRow[], now: number, cap = ONLINE_SCORES_CAP): boolean {
  if (scores.length < cap) return false;
  const oldest = Math.min(...scores.map((s) => s.created_at));
  return oldest > now - DAY_MS;
}

/** The `code` textarea's starting source: valid against the documented trace object (see docs/observability.md "Online evaluators"). */
export const SAMPLE_CODE = `(trace) => {
  // trace: { trace_id, agent_id, name, status, start, end, duration_ms,
  //          input, output, error_message, observations (oldest first, max 200) }
  if (trace.status === 'error') return { value: 0, comment: trace.error_message ?? 'run failed' };
  const tools = trace.observations.filter((o) => o.kind === 'tool').length;
  return { value: trace.output ? 1 : 0, comment: tools + ' tool call(s)' };
}`;
