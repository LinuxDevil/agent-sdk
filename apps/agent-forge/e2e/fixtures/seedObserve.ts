import type { Page, Route } from '@playwright/test';
import type { ObserveAgentRow, ObserveObservationRow, ObserveTraceDetail, ObserveTraceRow } from '../../src/observe/types';

/**
 * A deterministic trace seed for the revamp acceptance suite, the same shape
 * `.smoke/seed-eval.ts` produces against a live daemon (mock-model runs of
 * three agents) without running one: 60 traces over the last 18 h across
 * `orders-bot`, `billing-bot` and `triage-bot` on `mock/gpt-sim`, every 5th
 * run failing with `upstream 529 overloaded`, one tool failure
 * (`order service 503`), one slow run (2.6 s) inside the last 24 h and an even
 * slower one (3.4 s) older than 24 h, so a 24 h window is what makes the slow
 * run the slowest.
 *
 * `seedObserve(page)` answers `GET /observe/api/v1/traces` (honouring the
 * filter, sort and paging params the Traces screen sends, like the daemon),
 * `/api/v1/traces/:id` for seeded traces and `/api/v1/agents`; everything
 * else falls through to `stubObserve`. Register it after `stubObserve(page)`
 * (later routes run first).
 */
const NOW = Date.now();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The model every seeded generation ran on. */
const SEED_MODEL = 'mock/gpt-sim';
/** The provider error every 5th run fails with. */
export const SEED_ERROR = 'upstream 529 overloaded';
/** The one tool failure. */
const SEED_TOOL_ERROR = 'order service 503';

const AGENTS = [
  { id: 'orders-bot', name: 'Orders bot', project: 'shop' },
  { id: 'billing-bot', name: 'Billing bot', project: 'shop' },
  { id: 'triage-bot', name: 'Triage bot', project: 'support' },
] as const;

const SLOW_INDEX = 12;
const TOOL_ERROR_INDEX = 7;

interface SeedRun {
  row: ObserveTraceRow;
  /** Which step failed, if any. */
  failure: 'model' | 'tool' | null;
}

function seedRun(id: string, i: number, start: number, duration: number, failure: SeedRun['failure']): SeedRun {
  const agent = AGENTS[i % AGENTS.length];
  const input = 300 + i * 3 + (failure === 'model' ? 0 : 420 + i * 3);
  const output = failure === 'model' ? 0 : 55;
  return {
    failure,
    row: {
      trace_id: id,
      name: `${agent.id} turn`,
      agent_id: agent.id,
      session_id: `seed-session-${i % 6}`,
      start,
      end: start + duration,
      status: failure ? 'error' : 'ok',
      observations: failure === 'model' ? 2 : 4,
      generations: failure === 'model' ? 1 : 2,
      tools: failure === 'model' ? 0 : 1,
      errors: failure ? 1 : 0,
      input_tokens: input,
      output_tokens: output,
      cost_usd: (input + output) * 1e-6,
      agent_name: agent.name,
      model: SEED_MODEL,
      error_message: failure === 'model' ? SEED_ERROR : failure === 'tool' ? SEED_TOOL_ERROR : null,
      input_preview: `Where is order ord_${i}?`,
      output_preview: failure === 'model' ? null : `Order ord_${i} has shipped.`,
    },
  };
}

const runs: SeedRun[] = Array.from({ length: 60 }, (_, i) => {
  const failure = i % 5 === 4 ? 'model' : i === TOOL_ERROR_INDEX ? 'tool' : null;
  const duration = i === SLOW_INDEX ? 2_600 : 300 + (i % 7) * 90 + (i % 5) * 40;
  return seedRun(`seed-${String(i).padStart(3, '0')}`, i, NOW - (i + 1) * 18 * MINUTE, duration, failure);
});
// Older than 24 h and slower than anything inside it.
runs.push(seedRun('seed-old-slow', 60, NOW - 30 * HOUR, 3_400, null));

/** Every seeded trace row, newest first. */
const SEED_TRACES: readonly ObserveTraceRow[] = runs.map((r) => r.row);
/** The newest failed run (what the Traces list shows first among errors). */
export const SEED_NEWEST_FAILURE = SEED_TRACES.find((t) => t.error_message === SEED_ERROR)!;
/** The slowest run inside the last 24 h. */
export const SEED_SLOWEST_24H = SEED_TRACES[SLOW_INDEX];
/** A run slower still, but older than 24 h. */
export const SEED_OLD_SLOW = SEED_TRACES[SEED_TRACES.length - 1];

const agentRows: ObserveAgentRow[] = AGENTS.map((a) => ({
  agent_id: a.id,
  project: a.project,
  name: a.name,
  version: '1.0.0',
  first_seen: NOW - 48 * HOUR,
  last_heartbeat: NOW - 5_000,
  status: 'online',
  heartbeat_age_ms: 5_000,
  heartbeat_interval_ms: 15_000,
  hostname: 'seed-host',
  pid: 4242,
  dropped: 0,
  runs_today: SEED_TRACES.filter((t) => t.agent_id === a.id).length,
  error_rate_today: 0.2,
}));
const projectOf = new Map<string, string>(AGENTS.map((a) => [a.id, a.project]));

function obs(row: ObserveTraceRow, o: Partial<ObserveObservationRow> & Pick<ObserveObservationRow, 'obs_id' | 'kind' | 'name' | 'start' | 'end'>): ObserveObservationRow {
  return {
    trace_id: row.trace_id,
    session_id: row.session_id,
    agent_id: row.agent_id,
    parent_obs_id: `${row.trace_id}-root`,
    status: 'ok',
    input: null,
    output: null,
    model: null,
    usage_input_tokens: null,
    usage_output_tokens: null,
    usage_cached_tokens: null,
    usage_reasoning_tokens: null,
    cost_usd: null,
    cost_partial: null,
    usage_estimated: null,
    truncated: false,
    attrs: null,
    ...o,
  };
}

/** The observation tree of a seeded run: agent root, a generation, and (unless the model failed) the tool call plus the final generation. */
function detailOf({ row, failure }: SeedRun): ObserveTraceDetail {
  const { trace_id: id, start, end } = row;
  const span = end - start;
  const failed = (message: string) => ({ status: 'error', attrs: { error: message } });
  const root = obs(row, {
    obs_id: `${id}-root`,
    parent_obs_id: null,
    kind: 'agent',
    name: row.name,
    start,
    end,
    input: row.input_preview,
    output: row.output_preview,
    ...(row.error_message ? failed(row.error_message) : {}),
  });
  const firstGen = obs(row, {
    obs_id: `${id}-gen-1`,
    kind: 'generation',
    name: 'llm',
    start: start + 10,
    end: start + Math.round(span * 0.4),
    input: JSON.stringify([{ role: 'user', content: row.input_preview }]),
    model: SEED_MODEL,
    usage_input_tokens: 300,
    usage_output_tokens: failure === 'model' ? 0 : 20,
    ...(failure === 'model' ? failed(SEED_ERROR) : { output: 'calling lookup_order' }),
  });
  if (failure === 'model') return { trace_id: id, observations: [root, firstGen], scores: [] };
  const tool = obs(row, {
    obs_id: `${id}-tool`,
    kind: 'tool',
    name: 'lookup_order',
    start: start + Math.round(span * 0.4) + 5,
    end: start + Math.round(span * 0.6),
    input: '{"id":"ord"}',
    ...(failure === 'tool' ? failed(SEED_TOOL_ERROR) : { output: '{"status":"shipped"}' }),
  });
  const finalGen = obs(row, {
    obs_id: `${id}-gen-2`,
    kind: 'generation',
    name: 'llm',
    start: start + Math.round(span * 0.6) + 5,
    end: end - 5,
    model: SEED_MODEL,
    output: row.output_preview,
    usage_input_tokens: 420,
    usage_output_tokens: 35,
  });
  return { trace_id: id, observations: [root, firstGen, tool, finalGen], scores: [] };
}

const SORT_KEYS: Record<string, (t: ObserveTraceRow) => number> = {
  start: (t) => t.start,
  duration: (t) => t.end - t.start,
  tokens: (t) => t.input_tokens + t.output_tokens,
  cost: (t) => t.cost_usd,
};

const num = (q: URLSearchParams, key: string): number | undefined => {
  const v = q.get(key);
  return v === null || v === '' ? undefined : Number(v);
};

/** Filter, sort and page the seed the way the daemon's `GET /api/v1/traces` does. */
function queryTraces(q: URLSearchParams): { traces: ObserveTraceRow[]; total: number; limit: number; offset: number } {
  const text = q.get('q')?.toLowerCase();
  const from = num(q, 'from');
  const to = num(q, 'to');
  const since = num(q, 'since');
  const until = num(q, 'until');
  const minDuration = num(q, 'min_duration_ms');
  const matches = (t: ObserveTraceRow): boolean =>
    (!q.get('status') || t.status === q.get('status')) &&
    (!q.get('agent_id') || t.agent_id === q.get('agent_id')) &&
    (!q.get('model') || t.model === q.get('model')) &&
    (!q.get('session_id') || t.session_id === q.get('session_id')) &&
    (!q.get('project') || projectOf.get(t.agent_id ?? '') === q.get('project')) &&
    (from === undefined || t.start >= from) &&
    (to === undefined || t.start < to) &&
    (since === undefined || t.start >= since) &&
    (until === undefined || t.start <= until) &&
    (minDuration === undefined || t.end - t.start >= minDuration) &&
    (!text || [t.name, t.input_preview, t.output_preview].some((s) => s?.toLowerCase().includes(text)));
  const key = SORT_KEYS[q.get('sort') ?? 'start'] ?? SORT_KEYS.start;
  const dir = q.get('order') === 'asc' ? 1 : -1;
  const all = SEED_TRACES.filter(matches).sort((a, b) => dir * (key(a) - key(b)) || b.start - a.start);
  const limit = num(q, 'limit') ?? 50;
  const offset = num(q, 'offset') ?? 0;
  return { traces: all.slice(offset, offset + limit), total: all.length, limit, offset };
}

const details = new Map(runs.map((r) => [r.row.trace_id, detailOf(r)]));

const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

/** Serve the seed behind the studio's `/observe` proxy; register after `stubObserve(page)`. */
export async function seedObserve(page: Page): Promise<void> {
  await page.route('**/observe/api/v1/**', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/observe/, '');
    if (path === '/api/v1/traces') return json(route, queryTraces(url.searchParams));
    if (path === '/api/v1/agents') return json(route, { agents: agentRows });
    const detail = /^\/api\/v1\/traces\/([^/]+)$/.exec(path);
    const seeded = detail && details.get(decodeURIComponent(detail[1]));
    if (seeded) return json(route, seeded);
    return route.fallback();
  });
}
