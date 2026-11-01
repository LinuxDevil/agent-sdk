/**
 * Browser-side client for the runtime control server
 * (apps/agent-forge/server/**). Talks to it over plain `fetch` for
 * run/stop/status/approve and a `WebSocket` for the live status/event
 * stream - this is the app's only dependency on the server's wire shape,
 * so the two can evolve together without every component knowing the HTTP
 * details.
 */
import type { AgentSpec, AgentSpecV2 } from 'lousho';
import type {
  AddWorkspaceRequest,
  AgentListItem,
  AgentRecord,
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
  McpProbeRequest,
  McpProbeResponse,
  McpServerSpecV2,
  ProviderKeyStatus,
  RunComparisonPayload,
  RunHistoryPayload,
  SecretStatus,
  SettingsFile,
  SettingsProfile,
  SettleDraftRequest,
  SpecChange,
  StreamMessage,
  SpanEvent,
  TraceDetailPayload,
  TraceSummaryPayload,
  VersionListItem,
  VersionRecord,
  WorkspaceInfo,
  WorkspaceList,
  WorkspaceListItem,
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

  /** The saved agents in the studio's `.lousho/agents/` (the v1 list - `?view=legacy` until the canvas moves to v2). */
  async listAgents(): Promise<AgentStoreEntry[]> {
    return this.request('/agents?view=legacy', { method: 'GET' });
  }

  /** One saved agent's v1 spec (the legacy view), or undefined when there is none. */
  async loadAgent(agentId: string): Promise<AgentSpec | undefined> {
    try {
      return await this.request<AgentSpec>(`/agents/${encodeURIComponent(agentId)}?view=legacy`, { method: 'GET' });
    } catch (error) {
      if (error instanceof RuntimeApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  /** Writes `.lousho/agents/<id>.yaml` from a v1 spec (the server merges it onto the stored v2 spec). */
  async saveAgent(agentId: string, spec: AgentSpec): Promise<void> {
    await this.request(`/agents/${encodeURIComponent(agentId)}`, { method: 'PUT', body: JSON.stringify(spec) });
  }

  /** The Agents list's rows: one `AgentListItem` per saved spec (`GET /agents`, the v2 shape). */
  async listAgentItems(): Promise<AgentListItem[]> {
    return this.request('/agents', { method: 'GET' });
  }

  /** One agent's `AgentRecord` - spec v2 plus meta, layout and the latest version - or undefined on a 404. */
  async getAgentRecord(agentId: string): Promise<AgentRecord | undefined> {
    try {
      return await this.request<AgentRecord>(`/agents/${encodeURIComponent(agentId)}`, { method: 'GET' });
    } catch (error) {
      if (error instanceof RuntimeApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  /** Saves an AgentSpecV2 working copy (`PUT /agents/:id` with a `{ spec }` body). */
  async saveAgentSpec(agentId: string, spec: AgentSpecV2): Promise<void> {
    await this.request(`/agents/${encodeURIComponent(agentId)}`, {
      method: 'PUT',
      body: JSON.stringify({ spec }),
    });
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

  // -------------------------------------------------------------------
  // `/agents/:id/versions` - the version history (Versions tab + the
  // explicit Save). See server/routes/versionRoutes.ts.
  // -------------------------------------------------------------------

  /** The agent's version list, newest first (empty when it has none). */
  async listVersions(agentId: string): Promise<VersionListItem[]> {
    return this.request(`/agents/${encodeURIComponent(agentId)}/versions`, { method: 'GET' });
  }

  /** One version's full record (item + restorable snapshot); 404 when absent. */
  async getVersion(agentId: string, n: number): Promise<VersionRecord> {
    return this.request(`/agents/${encodeURIComponent(agentId)}/versions/${n}`, { method: 'GET' });
  }

  /** The changes version `n` introduces over `against` (or over the version below it). */
  async diffVersion(agentId: string, n: number, against?: number): Promise<SpecChange[]> {
    const query = against === undefined ? '' : `?${new URLSearchParams({ against: String(against) })}`;
    return this.request(`/agents/${encodeURIComponent(agentId)}/versions/${n}/diff${query}`, { method: 'GET' });
  }

  /** Restores version `n` as a new `kind: 'restore'` version (the working copy and labels go back; `meta.enabled` is untouched). */
  async restoreVersion(agentId: string, n: number): Promise<VersionListItem> {
    return this.request(`/agents/${encodeURIComponent(agentId)}/versions/${n}/restore`, { method: 'POST' });
  }

  /**
   * Explicit "Save version" of the working copy. `created` is the server's
   * status: 201 when a version was written, 200 when the working copy
   * already equals the latest version (a no-op answering with that item).
   */
  async saveVersion(agentId: string): Promise<{ item: VersionListItem; created: boolean }> {
    const res = await this.fetch(`/agents/${encodeURIComponent(agentId)}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'editor' }),
    });
    const body = (await res.json().catch(() => undefined)) as (VersionListItem & { error?: string }) | undefined;
    if (!res.ok || body === undefined) {
      throw apiError(body, `Save version of '${agentId}' failed with ${res.status}`, res.status);
    }
    return { item: body, created: res.status === 201 };
  }

  /** The workspace the studio serves (`baseDir` is its root; `workspace` is the full ref for addressing it by id). */
  async workspace(): Promise<WorkspaceInfo> {
    return this.request('/workspace', { method: 'GET' });
  }

  // -------------------------------------------------------------------
  // `/workspaces` - the workspace registry (server/workspace/workspaceRoutes.ts).
  // Read by the switcher, the Settings card and the aggregate agent list.
  // -------------------------------------------------------------------

  /** Every registered workspace plus live `available`/`agentCount` facts; `defaultId` is the launch workspace. */
  async listWorkspaces(): Promise<WorkspaceList> {
    return this.request('/workspaces', { method: 'GET' });
  }

  /**
   * "Add workspace → folder path": registers `root` as a workspace. The
   * folder path goes in the POST body, never the URL (it can name a
   * user's home directory). Rejects with the server's `{ error, code }`
   * on a 400 (bad/missing/not a folder) or 409 (already added).
   */
  async addWorkspace(root: string): Promise<WorkspaceListItem> {
    const body: AddWorkspaceRequest = { root };
    return this.request('/workspaces', { method: 'POST', body: JSON.stringify(body) });
  }

  /** Removes `id` from the registry - the folder on disk is never touched; the launch workspace always 409s. */
  async removeWorkspace(id: string): Promise<void> {
    await this.request(`/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' });
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

  // -------------------------------------------------------------------
  // `/settings/secrets` - named secrets (the values `{ secret: '<name>' }`
  // spec refs resolve to). Only masked statuses cross the wire, like
  // provider keys.
  // -------------------------------------------------------------------

  /** Masked status of every named secret, sorted by name. */
  async listSecrets(): Promise<SecretStatus[]> {
    return this.request('/settings/secrets', { method: 'GET' });
  }

  /** One named secret's masked status (`hasValue: false` when unset). */
  async getSecretStatus(name: string): Promise<SecretStatus> {
    return this.request(`/settings/secrets/${encodeURIComponent(name)}`, { method: 'GET' });
  }

  /** Stores (or replaces) the named secret's value. Resolves with the masked status - never the value. */
  async setSecret(name: string, value: string): Promise<SecretStatus> {
    return this.request(`/settings/secrets/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    });
  }

  /** Removes the named secret, if any. */
  async removeSecret(name: string): Promise<void> {
    await this.request(`/settings/secrets/${encodeURIComponent(name)}`, { method: 'DELETE' });
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
   * Probes one MCP server: connects it (secrets resolved server-side),
   * lists its tools and disconnects. A failure to connect comes back as
   * `{ ok: false, error }`, not a thrown error.
   */
  // fallow-ignore-next-line unused-class-member -- consumed by C07's MCP-node Probe button and AA06's probeMcpServer tool
  async probeMcp(server: McpServerSpecV2): Promise<McpProbeResponse> {
    const body: McpProbeRequest = { server };
    return this.request('/catalog/mcp/probe', { method: 'POST', body: JSON.stringify(body) });
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
