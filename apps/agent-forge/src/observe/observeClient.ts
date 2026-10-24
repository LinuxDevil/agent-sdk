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
  ObserveHealth,
  ObserveInsights,
  ObserveScoreRow,
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

export interface TraceListFilter {
  agent_id?: string;
  project?: string;
  status?: string;
  session_id?: string;
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
}

export interface ScoreListFilter {
  trace_id?: string;
  name?: string;
  agent_id?: string;
  limit?: number;
}

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

  private async request<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const headers = new Headers({ accept: 'application/json' });
    // The studio token only travels same-origin (to the studio server's
    // proxy, which requires it); a configured remote collector gets no header.
    if (this.baseUrl.startsWith('/')) {
      const token = loadStudioToken();
      if (token) headers.set(STUDIO_TOKEN_HEADER, token);
    }
    let res: Response;
    try {
      res = await this.fetchFn(this.url(path, query), { headers });
    } catch {
      throw new ObserveDaemonDownError();
    }
    if (res.status === 502) throw new ObserveDaemonDownError();
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
      throw new ObserveApiError(body?.error || `Request to ${path} failed with ${res.status}`, res.status);
    }
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
    return this.request('/api/v1/traces', { ...filter });
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

  /** `GET /api/v1/agents` - the fleet registry with read-time freshness. */
  async listAgents(project?: string): Promise<ObserveAgentRow[]> {
    const body = await this.request<{ agents: ObserveAgentRow[] }>('/api/v1/agents', { project });
    return body.agents;
  }

  /** `GET /api/v1/insights` - per-agent cards + rollup series. */
  insights(filter: InsightsFilter = {}): Promise<ObserveInsights> {
    return this.request('/api/v1/insights', { ...filter });
  }

  /** `GET /api/v1/scores` - eval/judge/human score rows. */
  async listScores(filter: ScoreListFilter = {}): Promise<ObserveScoreRow[]> {
    const body = await this.request<{ scores: ObserveScoreRow[] }>('/api/v1/scores', { ...filter });
    return body.scores;
  }
}

export const observeClient = new ObserveClient();
