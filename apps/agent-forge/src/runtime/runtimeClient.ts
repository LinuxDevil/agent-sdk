/**
 * Browser-side client for the runtime control server
 * (apps/agent-forge/server/**). Talks to it over plain `fetch` for
 * run/stop/status/approve and a `WebSocket` for the live status/event
 * stream - this is the app's only dependency on the server's wire shape,
 * so the two can evolve together without every component knowing the HTTP
 * details.
 */
import type { AgentSpec } from 'lousho';
import type {
  AgentRunStatusPayload,
  CatalogGuardrail,
  CatalogKit,
  CatalogModel,
  CatalogSkill,
  CatalogTool,
  CatalogTriggerType,
  ChangeDraft,
  ChatSessionMeta,
  ChatSessionRecord,
  ChatStatePayload,
  CreateDraftRequest,
  DebugStatePayload,
  DeployResult,
  ForkRunRequest,
  ForkRunResponse,
  ProviderKeyStatus,
  RunComparisonPayload,
  RunHistoryPayload,
  SettingsFile,
  SettingsProfile,
  SettleDraftRequest,
  StreamMessage,
  SpanEvent,
  TraceDetailPayload,
  TraceSummaryPayload,
  WorkspaceInfo,
} from '../../shared/wireTypes';
import { STUDIO_TOKEN_HEADER, loadStudioToken } from './studioToken';
import type { AgentStoreEntry } from '../persistence/AgentStore';
import type { AgentApi } from '../persistence/HttpAgentStore';

/** Same-origin default: `lousho studio` prints the API server's own URL, but in dev the Vite server proxies to it (see vite.config.ts). */
const DEFAULT_BASE_URL = '';

interface RuntimeClientOptions {
  baseUrl?: string;
  /** The per-launch API token; defaults to the one in the page URL (see studioToken.ts). */
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

/** Connection callbacks for `subscribe()` - `onLost` fires when the socket closes without the caller unsubscribing. */
export interface StreamConnectionHandlers {
  onOpen?: () => void;
  onLost?: () => void;
}

class RuntimeClient implements AgentApi {
  private readonly baseUrl: string;
  private readonly token: string | undefined;

  constructor(options: RuntimeClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.token = options.token ?? loadStudioToken();
  }

  /** `fetch` against the studio API, carrying the per-launch token. */
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

  /** The saved agents in the studio's `.lousho/agents/`. */
  async listAgents(): Promise<AgentStoreEntry[]> {
    return this.request('/agents', { method: 'GET' });
  }

  /** One saved agent's spec, or undefined when there is none. */
  async loadAgent(agentId: string): Promise<AgentSpec | undefined> {
    try {
      return await this.request<AgentSpec>(`/agents/${encodeURIComponent(agentId)}`, { method: 'GET' });
    } catch (error) {
      if (error instanceof RuntimeApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  /** Writes `.lousho/agents/<id>.yaml`. */
  async saveAgent(agentId: string, spec: AgentSpec): Promise<void> {
    await this.request(`/agents/${encodeURIComponent(agentId)}`, { method: 'PUT', body: JSON.stringify(spec) });
  }

  async deleteAgent(agentId: string): Promise<void> {
    await this.request(`/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' });
  }

  /** The agent's pending change draft, or `undefined` when it has none (the route answers 204). */
  async getDraft(agentId: string): Promise<ChangeDraft | undefined> {
    return this.request<ChangeDraft | undefined>(`/agents/${encodeURIComponent(agentId)}/draft`, {
      method: 'GET',
    });
  }

  /** Creates a pending change draft; the server displaces any existing one to history as withdrawn. */
  async createDraft(agentId: string, request: CreateDraftRequest): Promise<ChangeDraft> {
    return this.request<ChangeDraft>(`/agents/${encodeURIComponent(agentId)}/draft`, {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  /** Withdraws the pending draft to history; 404 when there is none. */
  async withdrawDraft(agentId: string): Promise<ChangeDraft> {
    return this.request<ChangeDraft>(`/agents/${encodeURIComponent(agentId)}/draft`, { method: 'DELETE' });
  }

  /** Applies the pending draft's patch over the current spec as a `source: 'draft'` version; 409 when `draftId` is stale. */
  async approveDraft(agentId: string, request?: SettleDraftRequest): Promise<ChangeDraft> {
    return this.request<ChangeDraft>(`/agents/${encodeURIComponent(agentId)}/draft/approve`, {
      method: 'POST',
      body: JSON.stringify(request ?? {}),
    });
  }

  /** Moves the pending draft to history as rejected, keeping the working copy. */
  async rejectDraft(agentId: string, request?: SettleDraftRequest): Promise<ChangeDraft> {
    return this.request<ChangeDraft>(`/agents/${encodeURIComponent(agentId)}/draft/reject`, {
      method: 'POST',
      body: JSON.stringify(request ?? {}),
    });
  }

  /** The workspace the studio serves (`baseDir` is its root; `workspace` is the full ref for addressing it by id). */
  async workspace(): Promise<WorkspaceInfo> {
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

  /** Current breakpoints + pause state for `agentId` (see debugController.ts). */
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

  /** Sends a chat message - continues the agent's conversation (or starts one), replying over the WS `subscribe()` stream as `{type:'chat'}`. */
  async sendMessage(agentId: string, message: string, spec?: AgentSpec): Promise<AgentRunStatusPayload> {
    // Send the canvas's current spec along, like run() does, so
    // chat never runs a stale (or missing) saved spec.
    return this.request(`/agents/${encodeURIComponent(agentId)}/message`, {
      method: 'POST',
      body: JSON.stringify({ message, spec }),
    });
  }

  /** REST snapshot of the current live chat transcript (mirrors the WS stream's initial `{type:'chat'}` push). */
  async getChat(agentId: string): Promise<ChatStatePayload> {
    return this.request(`/agents/${encodeURIComponent(agentId)}/chat`, { method: 'GET' });
  }

  /** Archives the current chat session and starts a fresh, empty one. */
  async newChat(agentId: string): Promise<ChatStatePayload> {
    return this.request(`/agents/${encodeURIComponent(agentId)}/chat/new`, { method: 'POST' });
  }

  /** Metadata for every past (and current) chat session for `agentId`, newest first. */
  async listChats(agentId: string): Promise<ChatSessionMeta[]> {
    return this.request(`/agents/${encodeURIComponent(agentId)}/chats`, { method: 'GET' });
  }

  /** A full past chat session's transcript. */
  async loadChatSession(agentId: string, sessionId: string): Promise<ChatSessionRecord> {
    return this.request(`/agents/${encodeURIComponent(agentId)}/chats/${encodeURIComponent(sessionId)}`, {
      method: 'GET',
    });
  }

  /** The steps of run `runId`'s checkpoint history (a run id is the agent id, or a fork's id). */
  async runHistory(runId: string): Promise<RunHistoryPayload> {
    return this.request(`/runs/${encodeURIComponent(runId)}/history`, { method: 'GET' });
  }

  /** The agent's persisted traces (the files `lousho traces` reads), newest first. */
  async listTraces(agentId: string, limit?: number): Promise<TraceSummaryPayload[]> {
    const query = limit === undefined ? '' : `?${new URLSearchParams({ limit: String(limit) })}`;
    const body = await this.request<{ traces: TraceSummaryPayload[] }>(
      `/agents/${encodeURIComponent(agentId)}/traces${query}`,
      { method: 'GET' }
    );
    return body.traces;
  }

  /** The spans of one persisted trace. */
  async readTrace(agentId: string, traceId: string): Promise<SpanEvent[]> {
    const body = await this.request<TraceDetailPayload>(
      `/agents/${encodeURIComponent(agentId)}/traces/${encodeURIComponent(traceId)}`,
      { method: 'GET' }
    );
    return body.spans;
  }

  /** Forks run `runId` at a step, patched, and starts the fork - its status streams on `subscribe(response.runId)`. */
  async forkRun(runId: string, body: ForkRunRequest): Promise<ForkRunResponse> {
    return this.request(`/runs/${encodeURIComponent(runId)}/fork`, { method: 'POST', body: JSON.stringify(body) });
  }

  /** `compareTrajectories()` of two runs, for the side-by-side view. */
  async compareRuns(a: string, b: string): Promise<RunComparisonPayload> {
    const query = new URLSearchParams({ a, b });
    return this.request(`/runs/compare?${query}`, { method: 'GET' });
  }

  /** Masked status of every managed provider's stored key. */
  async listProviderKeys(): Promise<ProviderKeyStatus[]> {
    return this.request('/settings/providers', { method: 'GET' });
  }

  /** Stores (or replaces) `provider`'s API key. Resolves with the new masked status - never the real key. */
  async setProviderKey(provider: string, apiKey: string): Promise<ProviderKeyStatus> {
    return this.request(`/settings/providers/${encodeURIComponent(provider)}`, {
      method: 'PUT',
      body: JSON.stringify({ apiKey }),
    });
  }

  /** Removes `provider`'s stored key, if any. */
  async removeProviderKey(provider: string): Promise<void> {
    await this.request(`/settings/providers/${encodeURIComponent(provider)}`, { method: 'DELETE' });
  }

  /** Every settings profile + which one is active. */
  async listSettingsProfiles(): Promise<SettingsFile> {
    return this.request('/settings/profiles', { method: 'GET' });
  }

  /** Creates or replaces a profile by id. */
  async saveSettingsProfile(profile: SettingsProfile): Promise<SettingsFile> {
    return this.request(`/settings/profiles/${encodeURIComponent(profile.id)}`, {
      method: 'PUT',
      body: JSON.stringify(profile),
    });
  }

  /** Switches the active profile. */
  async activateSettingsProfile(profileId: string): Promise<SettingsFile> {
    return this.request(`/settings/profiles/${encodeURIComponent(profileId)}/activate`, { method: 'POST' });
  }

  /** R2: deploy-target names this app's Settings dropdown offers - see server/deployRunner.ts's DEPLOY_ADAPTERS. */
  async listDeployAdapters(): Promise<string[]> {
    return this.request('/settings/deploy-adapters', { method: 'GET' });
  }

  // -------------------------------------------------------------------
  // `GET /catalog/*` - the SDK catalogs + registry index the pickers and
  // the Author read (server/routes/catalogRoutes.ts).
  // -------------------------------------------------------------------

  /** The model catalog, optionally filtered to one provider; `available` counts Studio-stored keys server-side. */
  async catalogModels(provider?: string): Promise<CatalogModel[]> {
    const query = provider === undefined ? '' : `?${new URLSearchParams({ provider })}`;
    return this.request(`/catalog/models${query}`, { method: 'GET' });
  }

  /** The SDK's `{ builtin }` tool catalog. */
  async catalogTools(): Promise<CatalogTool[]> {
    return this.request('/catalog/tools', { method: 'GET' });
  }

  /** The SDK's starter-set guardrail catalog. */
  async catalogGuardrails(): Promise<CatalogGuardrail[]> {
    return this.request('/catalog/guardrails', { method: 'GET' });
  }

  /** The SDK's trigger-type catalog. */
  async catalogTriggers(): Promise<CatalogTriggerType[]> {
    return this.request('/catalog/triggers', { method: 'GET' });
  }

  /** The registry index's skills, as `{ registry: name }` refs. */
  async catalogSkills(): Promise<CatalogSkill[]> {
    return this.request('/catalog/skills', { method: 'GET' });
  }

  /** The registry index's kits (whole agent directories). */
  async catalogKits(): Promise<CatalogKit[]> {
    return this.request('/catalog/kits', { method: 'GET' });
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
    onError?: (event: Event) => void,
    connection?: StreamConnectionHandlers
  ): () => void {
    const query = this.token ? `?${new URLSearchParams({ token: this.token })}` : '';
    const ws = new WebSocket(`${this.wsBaseUrl()}/agents/${encodeURIComponent(agentId)}/stream${query}`);
    let closedByCaller = false;
    ws.addEventListener('message', (event) => {
      try {
        onMessage(JSON.parse(event.data as string) as StreamMessage);
      } catch {
        // Ignore malformed frames rather than crashing the UI over one bad message.
      }
    });
    if (onError) ws.addEventListener('error', onError);
    // Tell the caller when the stream opens, and when it drops
    // for any reason other than the caller's own unsubscribe.
    if (connection?.onOpen) ws.addEventListener('open', connection.onOpen);
    ws.addEventListener('close', () => {
      if (!closedByCaller) connection?.onLost?.();
    });
    return () => {
      closedByCaller = true;
      ws.close();
    };
  }
}

export { RuntimeClient };
export const runtimeClient = new RuntimeClient();
