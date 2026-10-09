/**
 * Browser-side client for the LOU-N runtime control server
 * (apps/agent-forge/server/**). Talks to it over plain `fetch` for
 * run/stop/status/approve and a `WebSocket` for the live status/event
 * stream - this is the app's only dependency on the server's wire shape,
 * so the two can evolve together without every component knowing the HTTP
 * details.
 */
import type { AgentSpec } from '@lousho/build-ai-agent';
import type {
  AgentRunStatusPayload,
  ChatSessionMeta,
  ChatSessionRecord,
  ChatStatePayload,
  DebugStatePayload,
  DeployResult,
  ForkRunRequest,
  ForkRunResponse,
  ProviderKeyStatus,
  RunComparisonPayload,
  RunHistoryPayload,
  SettingsFile,
  SettingsProfile,
  StreamMessage,
  SpanEvent,
  TraceDetailPayload,
  TraceSummaryPayload,
} from '../../shared/wireTypes';
import { STUDIO_TOKEN_HEADER, loadStudioToken } from './studioToken';
import type { AgentStoreEntry } from '../persistence/AgentStore';

/** Same-origin default: `lousho studio` prints the API server's own URL, but in dev the Vite server proxies to it (see vite.config.ts). */
const DEFAULT_BASE_URL = '';

interface RuntimeClientOptions {
  baseUrl?: string;
  /** Eve DUI-F1: the per-launch API token; defaults to the one in the page URL (see studioToken.ts). */
  token?: string;
}

/** Builds the error for a non-ok response: the server's `{ error }` message when present, else `fallback`. */
function apiError(body: { error?: string } | undefined, fallback: string, status: number): RuntimeApiError {
  return new RuntimeApiError(body?.error || fallback, status);
}

export class RuntimeApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

class RuntimeClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;

  constructor(options: RuntimeClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.token = options.token ?? loadStudioToken();
  }

  /** `fetch` against the studio API, carrying the per-launch token (Eve DUI-F1). */
  private fetch(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    if (this.token) headers.set(STUDIO_TOKEN_HEADER, this.token);
    return fetch(`${this.baseUrl}${path}`, { ...init, headers });
  }

  private wsBaseUrl(): string {
    if (this.baseUrl) {
      return this.baseUrl.replace(/^http/, 'ws');
    }
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}`;
  }

  private async request<T = AgentRunStatusPayload>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
    const body = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    if (!res.ok) {
      throw apiError(body, `Request to ${path} failed with ${res.status}`, res.status);
    }
    return body as T;
  }

  /** Eve DUI-F2: the saved agents in the studio's `.lousho/agents/`. */
  async listAgents(): Promise<AgentStoreEntry[]> {
    return this.request('/agents', { method: 'GET' });
  }

  /** Eve DUI-F2: one saved agent's spec, or undefined when there is none. */
  async loadAgent(agentId: string): Promise<AgentSpec | undefined> {
    try {
      return await this.request<AgentSpec>(`/agents/${encodeURIComponent(agentId)}`, { method: 'GET' });
    } catch (error) {
      if (error instanceof RuntimeApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  /** Eve DUI-F2: writes `.lousho/agents/<id>.yaml`. */
  async saveAgent(agentId: string, spec: AgentSpec): Promise<void> {
    await this.request(`/agents/${encodeURIComponent(agentId)}`, { method: 'PUT', body: JSON.stringify(spec) });
  }

  async deleteAgent(agentId: string): Promise<void> {
    await this.request(`/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' });
  }

  /** Eve DUI-F2: the directory the studio serves (`.lousho/` lives under it). */
  async workspace(): Promise<{ baseDir: string }> {
    return this.request('/workspace', { method: 'GET' });
  }

  async run(agentId: string, input: string, spec: AgentSpec): Promise<AgentRunStatusPayload> {
    return this.request(`/agents/${encodeURIComponent(agentId)}/run`, {
      method: 'POST',
      body: JSON.stringify({ input, spec }),
    });
  }

  async stop(agentId: string): Promise<AgentRunStatusPayload> {
    return this.request(`/agents/${encodeURIComponent(agentId)}/stop`, { method: 'POST' });
  }

  async status(agentId: string): Promise<AgentRunStatusPayload> {
    return this.request(`/agents/${encodeURIComponent(agentId)}/status`, { method: 'GET' });
  }

  async approve(
    agentId: string,
    approvalId: string,
    approved: boolean,
    note?: string
  ): Promise<AgentRunStatusPayload> {
    return this.request(`/agents/${encodeURIComponent(agentId)}/approve`, {
      method: 'POST',
      body: JSON.stringify({ approvalId, approved, note }),
    });
  }

  /** O3: current breakpoints + pause state for `agentId` (see debugController.ts). */
  async debugState(agentId: string): Promise<DebugStatePayload> {
    return this.request(`/agents/${encodeURIComponent(agentId)}/debug`, { method: 'GET' });
  }

  async setBreakpoints(agentId: string, breakpoints: string[]): Promise<DebugStatePayload> {
    return this.request(`/agents/${encodeURIComponent(agentId)}/debug/breakpoints`, {
      method: 'PUT',
      body: JSON.stringify({ breakpoints }),
    });
  }

  async continueRun(agentId: string): Promise<DebugStatePayload> {
    return this.request(`/agents/${encodeURIComponent(agentId)}/debug/continue`, { method: 'POST' });
  }

  async stepRun(agentId: string): Promise<DebugStatePayload> {
    return this.request(`/agents/${encodeURIComponent(agentId)}/debug/step`, { method: 'POST' });
  }

  /** P1: sends a chat message - continues the agent's conversation (or starts one), replying over the WS `subscribe()` stream as `{type:'chat'}`. */
  async sendMessage(agentId: string, message: string, spec?: AgentSpec): Promise<AgentRunStatusPayload> {
    // Eve DUI-F7: send the canvas's current spec along, like run() does, so
    // chat never runs a stale (or missing) saved spec.
    return this.request(`/agents/${encodeURIComponent(agentId)}/message`, {
      method: 'POST',
      body: JSON.stringify({ message, spec }),
    });
  }

  /** P1: REST snapshot of the current live chat transcript (mirrors the WS stream's initial `{type:'chat'}` push). */
  async getChat(agentId: string): Promise<ChatStatePayload> {
    return this.request(`/agents/${encodeURIComponent(agentId)}/chat`, { method: 'GET' });
  }

  /** P3: archives the current chat session and starts a fresh, empty one. */
  async newChat(agentId: string): Promise<ChatStatePayload> {
    return this.request(`/agents/${encodeURIComponent(agentId)}/chat/new`, { method: 'POST' });
  }

  /** P3: metadata for every past (and current) chat session for `agentId`, newest first. */
  async listChats(agentId: string): Promise<ChatSessionMeta[]> {
    return this.request(`/agents/${encodeURIComponent(agentId)}/chats`, { method: 'GET' });
  }

  /** P3: a full past chat session's transcript. */
  async loadChatSession(agentId: string, sessionId: string): Promise<ChatSessionRecord> {
    return this.request(`/agents/${encodeURIComponent(agentId)}/chats/${encodeURIComponent(sessionId)}`, {
      method: 'GET',
    });
  }

  /** LOU-D45: the steps of run `runId`'s checkpoint history (a run id is the agent id, or a fork's id). */
  async runHistory(runId: string): Promise<RunHistoryPayload> {
    return this.request(`/runs/${encodeURIComponent(runId)}/history`, { method: 'GET' });
  }

  /** M5b: the agent's persisted traces (the files `lousho traces` reads), newest first. */
  async listTraces(agentId: string, limit?: number): Promise<TraceSummaryPayload[]> {
    const query = limit === undefined ? '' : `?${new URLSearchParams({ limit: String(limit) })}`;
    const body = await this.request<{ traces: TraceSummaryPayload[] }>(
      `/agents/${encodeURIComponent(agentId)}/traces${query}`,
      { method: 'GET' }
    );
    return body.traces;
  }

  /** M5b: the spans of one persisted trace. */
  async readTrace(agentId: string, traceId: string): Promise<SpanEvent[]> {
    const body = await this.request<TraceDetailPayload>(
      `/agents/${encodeURIComponent(agentId)}/traces/${encodeURIComponent(traceId)}`,
      { method: 'GET' }
    );
    return body.spans;
  }

  /** LOU-D45: forks run `runId` at a step, patched, and starts the fork - its status streams on `subscribe(response.runId)`. */
  async forkRun(runId: string, body: ForkRunRequest): Promise<ForkRunResponse> {
    return this.request(`/runs/${encodeURIComponent(runId)}/fork`, { method: 'POST', body: JSON.stringify(body) });
  }

  /** LOU-D45: `compareTrajectories()` of two runs, for the side-by-side view. */
  async compareRuns(a: string, b: string): Promise<RunComparisonPayload> {
    const query = new URLSearchParams({ a, b });
    return this.request(`/runs/compare?${query}`, { method: 'GET' });
  }

  /** R1: masked status of every managed provider's stored key. */
  async listProviderKeys(): Promise<ProviderKeyStatus[]> {
    return this.request('/settings/providers', { method: 'GET' });
  }

  /** R1: stores (or replaces) `provider`'s API key. Resolves with the new masked status - never the real key. */
  async setProviderKey(provider: string, apiKey: string): Promise<ProviderKeyStatus> {
    return this.request(`/settings/providers/${encodeURIComponent(provider)}`, {
      method: 'PUT',
      body: JSON.stringify({ apiKey }),
    });
  }

  /** R1: removes `provider`'s stored key, if any. */
  async removeProviderKey(provider: string): Promise<void> {
    await this.request(`/settings/providers/${encodeURIComponent(provider)}`, { method: 'DELETE' });
  }

  /** R3: every settings profile + which one is active. */
  async listSettingsProfiles(): Promise<SettingsFile> {
    return this.request('/settings/profiles', { method: 'GET' });
  }

  /** R3: creates or replaces a profile by id. */
  async saveSettingsProfile(profile: SettingsProfile): Promise<SettingsFile> {
    return this.request(`/settings/profiles/${encodeURIComponent(profile.id)}`, {
      method: 'PUT',
      body: JSON.stringify(profile),
    });
  }

  /** R3: deletes a profile (refuses to delete the last remaining one). */
  async deleteSettingsProfile(profileId: string): Promise<SettingsFile> {
    return this.request(`/settings/profiles/${encodeURIComponent(profileId)}`, { method: 'DELETE' });
  }

  /** R3: switches the active profile. */
  async activateSettingsProfile(profileId: string): Promise<SettingsFile> {
    return this.request(`/settings/profiles/${encodeURIComponent(profileId)}/activate`, { method: 'POST' });
  }

  /** R2: deploy-target names this app's Settings dropdown offers - see server/deployRunner.ts's DEPLOY_ADAPTERS. */
  async listDeployAdapters(): Promise<string[]> {
    return this.request('/settings/deploy-adapters', { method: 'GET' });
  }

  /**
   * R2: "Deploy this agent" - shells out to `lousho build --target=<adapter>` against this agent's saved spec.
   * A failed build answers 422 with the `DeployResult` (its exit code and output), which is returned, not thrown.
   */
  async deployAgent(agentId: string, adapter: string): Promise<DeployResult> {
    const res = await this.fetch(`/agents/${encodeURIComponent(agentId)}/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adapter }),
    });
    const body = (await res.json().catch(() => undefined)) as (DeployResult & { error?: string }) | undefined;
    if (!res.ok && (res.status !== 422 || typeof body?.exitCode !== 'number')) {
      throw apiError(body, `Deploy of '${agentId}' failed with ${res.status}`, res.status);
    }
    return body as DeployResult;
  }

  /**
   * Subscribes to `WS /agents/:id/stream`. Returns an unsubscribe function.
   * Reconnects are NOT handled here - a dropped connection just stops
   * updates until the caller re-subscribes (e.g. on next mount); the app
   * still has `status()` for a manual refresh, and this is best-effort
   * live UI, not the durable source of truth (the server/checkpoints are).
   */
  subscribe(
    agentId: string,
    onMessage: (message: StreamMessage) => void,
    onError?: (event: Event) => void
  ): () => void {
    const query = this.token ? `?${new URLSearchParams({ token: this.token })}` : '';
    const ws = new WebSocket(`${this.wsBaseUrl()}/agents/${encodeURIComponent(agentId)}/stream${query}`);
    ws.addEventListener('message', (event) => {
      try {
        onMessage(JSON.parse(event.data as string) as StreamMessage);
      } catch {
        // Ignore malformed frames rather than crashing the UI over one bad message.
      }
    });
    if (onError) ws.addEventListener('error', onError);
    return () => ws.close();
  }
}

export { RuntimeClient };
export const runtimeClient = new RuntimeClient();
