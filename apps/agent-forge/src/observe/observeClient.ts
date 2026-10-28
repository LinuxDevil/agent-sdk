/**
 * Browser-side client for the observe daemon's read API (`src/observe/routes/*`).
 *
 * The daemon answers on loopback only and sends no CORS headers, so the
 * default base is the same-origin `/observe` proxy: Vite's dev server forwards
 * it to the studio API server, which forwards it to the daemon
 * (`LOUSHO_OBSERVE_URL`, default `http://127.0.0.1:7777`). An absolute base -
 * `VITE_LOUSHO_OBSERVE_URL` at build time, or `localStorage['lousho.observe.url']`
 * at runtime - points the client straight at a collector (the hosted path the
 * spec leaves open); CORS is then the collector's job.
 */
import { STUDIO_TOKEN_HEADER, loadStudioToken } from '../runtime/studioToken';
import type {
  ObserveAgentRow,
  NewHubEntry,
  NewQueueScore,
  ObserveDataset,
  ObserveDatasetDetail,
  ObserveDatasetList,
  ObserveExample,
  ObserveQueue,
  ObserveQueueItem,
  ObserveQueueList,
  ObserveRubricEntry,
  ObserveHealth,
  ObserveHubEntry,
  ObserveHubScope,
  ObserveInsights,
  ObservePromptHistory,
  ObservePromptLabelMove,
  ObservePromptRow,
  ObserveScorePassRate,
  ObserveScoreRow,
  ObserveSessionDetail,
  ObserveSessionList,
  ObserveTraceDetail,
  ObserveTraceList,
} from './types';

const LOCAL_STORAGE_KEY = 'lousho.observe.url';
const DEFAULT_BASE = '/observe';

/** The observe base URL: localStorage override > build env > the same-origin proxy. */
function observeBaseUrl(): string {
  try {
    const stored = window.localStorage.getItem(LOCAL_STORAGE_KEY);
    if (stored && stored.trim()) return stored.trim().replace(/\/+$/, '');
  } catch {
    // Storage blocked (privacy mode): fall through to the env/proxy default.
  }
  const env = import.meta.env.VITE_LOUSHO_OBSERVE_URL as string | undefined;
  if (env && env.trim()) return env.trim().replace(/\/+$/, '');
  return DEFAULT_BASE;
}

/** Thrown when the daemon can't be reached at all (connection refused, or the studio proxy's 502). */
export class ObserveDaemonDownError extends Error {
  override readonly name = 'ObserveDaemonDownError';
  constructor(message = 'The observe daemon is not reachable.') {
    super(message);
  }
}

/** A non-2xx answer from the daemon (400/404/...). */
export class ObserveApiError extends Error {
  override readonly name = 'ObserveApiError';
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

export interface ObserveClientOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

/** The O12 trace-list params: a half-open `[from, to)` window (ms epoch), search over the root's name/input/output, and server-side order (daemon default `start` + `desc`). */
interface TraceListQuery {
  from?: number;
  to?: number;
  q?: string;
  min_duration_ms?: number;
  model?: string;
  sort?: TraceSort;
  order?: 'asc' | 'desc';
  /** `<name>` or `<name>@<version>`: traces where any observation ran that registry prompt. */
  prompt?: string;
}

export interface TraceListFilter extends TraceListQuery {
  agent_id?: string;
  project?: string;
  status?: string;
  session_id?: string;
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
}

/** The trace list's server-side sort keys. */
export type TraceSort = 'start' | 'duration' | 'tokens' | 'cost';

/** `GET /api/v1/sessions` params: sessions whose `started_at` is in the half-open `[from, to)` window (ms epoch). */
export interface SessionListFilter {
  agent_id?: string;
  status?: string;
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
}

export interface ScoreListFilter {
  trace_id?: string;
  /** Exact score name (`<evalName>` is the eval-level row of each case). */
  name?: string;
  /** Eval name: every score named `<eval>` or `<eval>/<check>`. */
  eval?: string;
  agent_id?: string;
  /** `eval` | `judge` | `human`. */
  source?: string;
  /** `created_at` lower bound (epoch ms). */
  since?: number;
  /** `created_at` upper bound (epoch ms). */
  until?: number;
  limit?: number;
}

/** The body of {@link ObserveClient.postScore}: `obs_id` omitted scores the whole trace. */
export interface NewScore {
  trace_id: string;
  obs_id?: string;
  name: string;
  value: number | null;
  comment?: string;
}

/** `GET /api/v1/hub` params. `agent_id` is required: the daemon enforces scope against it (no `scope` = every fleet entry plus that agent's private ones; max `limit` 1000). */
export interface HubEntryFilter {
  agent_id: string;
  namespace?: string;
  scope?: ObserveHubScope;
  limit?: number;
}

/** A page request (`limit`/`offset`) for the dataset list and a dataset's examples. */
export interface PageQuery {
  limit?: number;
  offset?: number;
}

/** The body of {@link ObserveClient.addExample}: a literal example, or one copied from a trace's root input/output. */
export type NewExample = { input: unknown; expected?: unknown } | { from_trace_id: string };

export interface InsightsFilter {
  days?: number;
  since?: number;
  until?: number;
  agent_id?: string;
  granularity?: 'hour' | 'day';
}

export class ObserveClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: ObserveClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? observeBaseUrl();
    // Resolved at call time, not construction: an early `fetch.bind(...)`
    // would freeze the pre-test-stub global (and an unbound `fetch` throws
    // "Illegal invocation" in some browsers).
    this.fetchFn = options.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  }

  private url(path: string, query?: Record<string, string | number | undefined>): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== '') params.set(key, String(value));
    }
    const qs = params.toString();
    return `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;
  }

  private async request<T>(
    path: string,
    opts: { query?: Record<string, string | number | undefined>; method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown } = {}
  ): Promise<T> {
    const headers = new Headers({ accept: 'application/json' });
    // The studio token only travels same-origin (to the studio server's
    // proxy, which requires it); a configured remote collector gets no header.
    if (this.baseUrl.startsWith('/')) {
      const token = loadStudioToken();
      if (token) headers.set(STUDIO_TOKEN_HEADER, token);
    }
    const init: RequestInit = { headers };
    if (opts.method && opts.method !== 'GET') init.method = opts.method;
    if (opts.body !== undefined) {
      headers.set('content-type', 'application/json');
      init.body = JSON.stringify(opts.body);
    }
    let res: Response;
    try {
      res = await this.fetchFn(this.url(path, opts.query), init);
    } catch {
      throw new ObserveDaemonDownError();
    }
    if (res.status === 502) throw new ObserveDaemonDownError();
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
      throw new ObserveApiError(body?.error || `Request to ${path} failed with ${res.status}`, res.status);
    }
    // 204 No Content (an example delete) has no body to parse.
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** `GET /health` - `undefined` when nothing (or not a lousho-observe daemon) answers. */
  async health(): Promise<ObserveHealth | undefined> {
    try {
      const health = await this.request<ObserveHealth>('/health');
      return health.service === 'lousho-observe' && health.ok ? health : undefined;
    } catch (error) {
      if (error instanceof ObserveDaemonDownError || error instanceof ObserveApiError) return undefined;
      throw error;
    }
  }

  /** The daemon URL reporters should use: the proxy's `__target` (same-origin), or the configured absolute base. `undefined` if unknown. */
  async target(): Promise<string | undefined> {
    if (!this.baseUrl.startsWith('/')) return this.baseUrl;
    try {
      const body = await this.request<{ url?: unknown }>('/__target');
      return typeof body.url === 'string' ? body.url : undefined;
    } catch {
      return undefined;
    }
  }

  /** `GET /api/v1/traces` - the paginated, filterable trace list. */
  listTraces(filter: TraceListFilter = {}): Promise<ObserveTraceList> {
    return this.request('/api/v1/traces', { query: { ...filter } });
  }

  /** `GET /api/v1/traces/:id` - flat observation rows + scores; `undefined` on the daemon's 404. */
  async traceDetail(traceId: string): Promise<ObserveTraceDetail | undefined> {
    try {
      return await this.request(`/api/v1/traces/${encodeURIComponent(traceId)}`);
    } catch (error) {
      if (error instanceof ObserveApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  /** `GET /api/v1/sessions` - the paginated thread list, newest first. */
  listSessions(filter: SessionListFilter = {}): Promise<ObserveSessionList> {
    return this.request('/api/v1/sessions', { query: { ...filter } });
  }

  /** `GET /api/v1/sessions/:id` - one thread plus its traces, oldest first; `undefined` on the daemon's 404. */
  async session(sessionId: string): Promise<ObserveSessionDetail | undefined> {
    try {
      return await this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}`);
    } catch (error) {
      if (error instanceof ObserveApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  /** `GET /api/v1/agents` - the fleet registry with read-time freshness. */
  async listAgents(project?: string): Promise<ObserveAgentRow[]> {
    const body = await this.request<{ agents: ObserveAgentRow[] }>('/api/v1/agents', { query: { project } });
    return body.agents;
  }

  /** `GET /api/v1/insights` - per-agent cards + rollup series. */
  insights(filter: InsightsFilter = {}): Promise<ObserveInsights> {
    return this.request('/api/v1/insights', { query: { ...filter } });
  }

  /** `GET /api/v1/prompts` - one row per prompt name (its latest version), with version and use counts. */
  async listPrompts(): Promise<ObservePromptRow[]> {
    const body = await this.request<{ prompts: ObservePromptRow[] }>('/api/v1/prompts');
    return body.prompts;
  }

  /** `GET /api/v1/prompts/:name` - the version history, newest first; `undefined` on the daemon's 404. */
  async promptVersions(name: string): Promise<ObservePromptHistory | undefined> {
    try {
      return await this.request(`/api/v1/prompts/${encodeURIComponent(name)}`);
    } catch (error) {
      if (error instanceof ObserveApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  /** `PUT /api/v1/prompts/:name/labels/:label {version}` - point `label` at `version`, moving it off its old one. */
  movePromptLabel(name: string, label: string, version: number): Promise<ObservePromptLabelMove> {
    return this.request(`/api/v1/prompts/${encodeURIComponent(name)}/labels/${encodeURIComponent(label)}`, {
      method: 'PUT',
      body: { version },
    });
  }

  /** `GET /api/v1/hub` - live (unexpired) Context Hub entries visible to `agent_id`, newest first. */
  async listHubEntries(filter: HubEntryFilter): Promise<ObserveHubEntry[]> {
    const body = await this.request<{ entries: ObserveHubEntry[] }>('/api/v1/hub', { query: { ...filter } });
    return body.entries;
  }

  /** `POST /api/v1/hub` - upsert one entry (per namespace, agent_id, key); republishing resets `created_at`, so the TTL restarts. */
  publishHubEntry(entry: NewHubEntry): Promise<{ entry: ObserveHubEntry | undefined; created: boolean }> {
    return this.request('/api/v1/hub', { method: 'POST', body: entry });
  }

  /** `GET /api/v1/scores` - eval/judge/human score rows. */
  async listScores(filter: ScoreListFilter = {}): Promise<ObserveScoreRow[]> {
    const body = await this.request<{ scores: ObserveScoreRow[] }>('/api/v1/scores', { query: { ...filter } });
    return body.scores;
  }

  /** `GET /api/v1/scores?aggregate=eval` - pass rate, mean and last seen per eval name (same filters as {@link listScores}). */
  async scorePassRates(filter: Omit<ScoreListFilter, 'limit'> = {}): Promise<ObserveScorePassRate[]> {
    const body = await this.request<{ evals: ObserveScorePassRate[] }>('/api/v1/scores', {
      query: { ...filter, aggregate: 'eval' },
    });
    return body.evals;
  }

  /** `POST /api/v1/scores` - a human feedback score (append-only); the daemon's 404/400 surface as `ObserveApiError`. */
  postScore(score: NewScore): Promise<{ score_id: string }> {
    return this.request('/api/v1/scores', { method: 'POST', body: score });
  }

  /** `GET /api/v1/datasets` - a page of datasets (with example counts), newest first. */
  listDatasets(page: PageQuery = {}): Promise<ObserveDatasetList> {
    return this.request('/api/v1/datasets', { query: { ...page } });
  }

  /** `GET /api/v1/datasets/:name` - the dataset plus a page of its examples, oldest first; `undefined` on the daemon's 404. */
  async dataset(name: string, page: PageQuery = {}): Promise<ObserveDatasetDetail | undefined> {
    try {
      return await this.request(`/api/v1/datasets/${encodeURIComponent(name)}`, { query: { ...page } });
    } catch (error) {
      if (error instanceof ObserveApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  /** `POST /api/v1/datasets` - a new, empty dataset; a taken name is the daemon's 409 (`ObserveApiError`). */
  async createDataset(input: { name: string; description?: string }): Promise<ObserveDataset> {
    const body = await this.request<{ dataset: ObserveDataset }>('/api/v1/datasets', { method: 'POST', body: input });
    return body.dataset;
  }

  /** `POST /api/v1/datasets/:name/examples` - one example, literal or `{ from_trace_id }` (the trace root's input/output). */
  async addExample(name: string, example: NewExample): Promise<ObserveExample> {
    const body = await this.request<{ example: ObserveExample }>(`/api/v1/datasets/${encodeURIComponent(name)}/examples`, {
      method: 'POST',
      body: example,
    });
    return body.example;
  }

  /** `DELETE /api/v1/datasets/:name/examples/:id` - removes one example (204). */
  async deleteExample(name: string, exampleId: string): Promise<void> {
    await this.request(`/api/v1/datasets/${encodeURIComponent(name)}/examples/${encodeURIComponent(exampleId)}`, {
      method: 'DELETE',
    });
  }

  /** `GET /api/v1/queues` - a page of annotation queues (with item counts per status), newest first. */
  listQueues(page: PageQuery = {}): Promise<ObserveQueueList> {
    return this.request('/api/v1/queues', { query: { ...page } });
  }

  /** `GET /api/v1/queues/:id` - one annotation queue; `undefined` on the daemon's 404. */
  async queue(queueId: string): Promise<ObserveQueue | undefined> {
    try {
      const body = await this.request<{ queue: ObserveQueue }>(`/api/v1/queues/${encodeURIComponent(queueId)}`);
      return body.queue;
    } catch (error) {
      if (error instanceof ObserveApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  /** `POST /api/v1/queues` - a new, empty annotation queue; a taken name is the daemon's 409 (`ObserveApiError`). */
  async createQueue(input: { name: string; rubric: ObserveRubricEntry[] }): Promise<ObserveQueue> {
    const body = await this.request<{ queue: ObserveQueue }>('/api/v1/queues', { method: 'POST', body: input });
    return body.queue;
  }

  /** `POST /api/v1/queues/:id/items` - queue traces for review; ones already in the queue count as `skipped_existing`. */
  addQueueItems(queueId: string, traceIds: string[]): Promise<{ added: number; skipped_existing: number }> {
    return this.request(`/api/v1/queues/${encodeURIComponent(queueId)}/items`, { method: 'POST', body: { trace_ids: traceIds } });
  }

  /** `GET /api/v1/queues/:id/next` - the oldest pending item (not claimed); `undefined` when the queue is empty (204). */
  async nextQueueItem(queueId: string): Promise<ObserveQueueItem | undefined> {
    const body = await this.request<{ item: ObserveQueueItem } | undefined>(`/api/v1/queues/${encodeURIComponent(queueId)}/next`);
    return body?.item;
  }

  /**
   * `POST /api/v1/queues/:id/items/:item/complete` - finish one item: `done` with its scores, or `skipped` with none.
   * An item someone already finished is the daemon's 409 (`ObserveApiError`).
   */
  async completeQueueItem(
    queueId: string,
    itemId: string,
    outcome: { scores: NewQueueScore[]; status?: 'done' | 'skipped' }
  ): Promise<{ item: ObserveQueueItem; score_ids: string[] }> {
    return this.request(`/api/v1/queues/${encodeURIComponent(queueId)}/items/${encodeURIComponent(itemId)}/complete`, {
      method: 'POST',
      body: outcome,
    });
  }

  /** `GET /api/v1/prompts/:name/:ref` (ref = `latest`, a version number or a label); `undefined` on the daemon's 404. */
  async getPrompt(name: string, ref = 'latest'): Promise<ObservePrompt | undefined> {
    try {
      const body = await this.request<{ prompt: ObservePrompt }>(
        `/api/v1/prompts/${encodeURIComponent(name)}/${encodeURIComponent(ref)}`
      );
      return body.prompt;
    } catch (error) {
      if (error instanceof ObserveApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  /** `POST /api/v1/prompts` - pushes a new version (`unchanged` when the text matches the latest one). */
  createPrompt(input: NewPromptVersion): Promise<PromptPushResult> {
    return this.request('/api/v1/prompts', { method: 'POST', body: input });
  }
}

/** One registry prompt version, as `GET /api/v1/prompts/:name/:ref` returns it. */
export interface ObservePrompt {
  prompt_id: string;
  name: string;
  version: number;
  labels: string[];
  /** `null` when the version was pushed without a variable list. */
  variables: string[] | null;
  hash: string;
  text: string;
  created_at: number;
}

/** The body of {@link ObserveClient.createPrompt}. */
export interface NewPromptVersion {
  name: string;
  text: string;
  labels?: string[];
  variables?: string[];
}

/** The answer of {@link ObserveClient.createPrompt}: the stored version, and whether it was new. */
export interface PromptPushResult {
  prompt: ObservePrompt;
  created: boolean;
  version: number;
  unchanged: boolean;
}

export const observeClient = new ObserveClient();
