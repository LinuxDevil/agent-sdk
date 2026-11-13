/**
 * Browser-side client for the runtime control server
 * (apps/agent-forge/server/**). Talks to it over plain `fetch` for
 * run/stop/status/approve and a `WebSocket` for the live status/event
 * stream - this is the app's only dependency on the server's wire shape,
 * so the two can evolve together without every component knowing the HTTP
 * details.
 */
import type { AgentSpecV2 } from '@linuxdevil/lousho';
import type {
  AddWorkspaceRequest,
  AgentListItem,
  AgentMeta,
  AllAgentsResponse,
  AllEventsFrame,
  AgentRecord,
  AgentRunStatusPayload,
  CanvasLayout,
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
  CodeAgentSpecResponse,
  CollectorStatus,
  CollectorUpdate,
  CreateAgentRequest,
  CreateDraftRequest,
  DebugStatePayload,
  DraftView,
  DeployResult,
  ForkRunRequest,
  ForkRunResponse,
  ImportPreview,
  ImportRequest,
  InboxCount,
  InboxItem,
  McpProbeRequest,
  McpProbeResponse,
  ChannelTriggerStatus,
  PassSettings,
  PassSettingsPatch,
  PassSpendSummary,
  RatingRequest,
  McpServerSpecV2,
  PatchAgentMetaRequest,
  PromptSuggestion,
  ProviderKeyStatus,
  PortabilityAnalysis,
  Requirement,
  RunComparisonPayload,
  RunHistoryPayload,
  SecretStatus,
  SettingsFile,
  SteerRequest,
  SteerResponse,
  SettingsProfile,
  SettleDraftRequest,
  SpecChange,
  StreamMessage,
  SpanEvent,
  StudioEvent,
  TemplateDetail,
  TemplateSummary,
  ToolPin,
  TraceDetailPayload,
  TraceSummaryPayload,
  HostStatus,
  VersionListItem,
  VersionRecord,
  WorkspaceInboxItem,
  WorkspaceInfo,
  WorkspaceList,
  WorkspaceListItem,
  WorkspaceScanResult,
} from '../../shared/wireTypes';
import { ALL_WORKSPACES, WORKSPACE_HEADER, WORKSPACE_QUERY } from '../../shared/workspace';
import { STUDIO_TOKEN_HEADER, loadStudioToken } from './studioToken';
import { activeWorkspace } from '../workspace/activeWorkspace';
import {
  AUTHOR_STREAM_PATH,
  type AuthorFocus,
  type AuthorSaveResponse,
  type AuthorSecretRequest,
  type AuthorSession,
  type AuthorSessionRecord,
  type AuthorSessionSummary,
  type AuthorSettings,
  type AuthorSettingsPayload,
  type SetEnabledOutput,
} from '../../shared/authorWire';
import type { AgentApi } from '../persistence/HttpAgentStore';

/** Same-origin default: `lousho studio` prints the API server's own URL, but in dev the Vite server proxies to it (see vite.config.ts). */
const DEFAULT_BASE_URL = '';

interface RuntimeClientOptions {
  baseUrl?: string;
  /** The per-launch API token; defaults to the one in the page URL (see studioToken.ts). */
  token?: string;
  /**
   * The workspace this client is bound to (W04a): when set, every request
   * carries `x-lousho-workspace: <id>` and every socket `?ws=<id>`
   * regardless of the URL's `#/w/…` segment. `forWorkspace(id)` builds
   * such a client; the default client leaves it unset and follows
   * `activeWorkspace()` instead.
   */
  workspaceId?: string;
}

/** Builds the error for a non-ok response: the server's `{ error }` message when present, else `fallback`, keeping `code` and `details`. */
function apiError(
  body: { error?: string; code?: string; details?: unknown } | undefined,
  fallback: string,
  status: number
): RuntimeApiError {
  return new RuntimeApiError(body?.error || fallback, status, body?.code, body?.details);
}

export class RuntimeApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** The server's `{ code }` when it sent one (e.g. 'STALE_PROPOSAL'). */
    public readonly code?: string,
    /** The server's `{ details }` payload when it sent one (e.g. `{ latestProposalId }`). */
    public readonly details?: unknown
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
  private readonly workspaceId: string | undefined;

  constructor(options: RuntimeClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.token = options.token ?? loadStudioToken();
    this.workspaceId = options.workspaceId;
  }

  /**
   * A client bound to workspace `id` (W04a): same base URL and token, but
   * the `x-lousho-workspace` header (and the sockets' `?ws=`) is always
   * `id` - for code that must talk to a workspace other than the one the
   * URL names, like the all-agents list (W06a).
   */
  forWorkspace(id: string): RuntimeClient {
    return new RuntimeClient({ baseUrl: this.baseUrl, token: this.token, workspaceId: id });
  }

  /** The workspace this request/socket targets: the bound id, else the URL's/launch workspace (`undefined` before `GET /workspaces` answers). */
  private targetWorkspace(): string | undefined {
    return this.workspaceId ?? activeWorkspace();
  }

  /** `fetch` against the studio API, carrying the per-launch token and the active workspace's `x-lousho-workspace` header. */
  private fetch(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    if (this.token) headers.set(STUDIO_TOKEN_HEADER, this.token);
    const ws = this.targetWorkspace();
    if (ws) headers.set(WORKSPACE_HEADER, ws);
    return fetch(`${this.baseUrl}${path}`, { ...init, headers });
  }

  private wsBaseUrl(): string {
    if (this.baseUrl) {
      return this.baseUrl.replace(/^http/, 'ws');
    }
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}`;
  }

  private subscribeJson<T>(
    path: string,
    onFrame: (frame: T) => void,
    connection?: StreamConnectionHandlers,
    onError?: (event: Event) => void
  ): () => void {
    const params = new URLSearchParams();
    if (this.token) params.set('token', this.token);
    const ws = this.targetWorkspace();
    if (ws) params.set(WORKSPACE_QUERY, ws);
    const query = params.size > 0 ? `?${params}` : '';
    const socket = new WebSocket(`${this.wsBaseUrl()}${path}${query}`);
    let closedByCaller = false;
    socket.addEventListener('message', (event) => {
      try {
        onFrame(JSON.parse(event.data as string) as T);
      } catch {
        return;
      }
    });
    if (onError) socket.addEventListener('error', onError);
    if (connection?.onOpen) socket.addEventListener('open', connection.onOpen);
    socket.addEventListener('close', () => {
      if (!closedByCaller) connection?.onLost?.();
    });
    return () => {
      closedByCaller = true;
      socket.close();
    };
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

  /** The saved agents in the studio's `.lousho/agents/` - one `AgentListItem` per spec (`GET /agents`). */
  async listAgents(): Promise<AgentListItem[]> {
    return this.request('/agents', { method: 'GET' });
  }

  /**
   * Every registered workspace's agents in one `AllAgentsResponse`
   * (`GET /agents?ws=all`, W06a): bound to `ALL_WORKSPACES` so the
   * `x-lousho-workspace` header can't override the aggregate with the
   * URL's workspace.
   */
  async listAllAgentItems(): Promise<AllAgentsResponse> {
    return this.forWorkspace(ALL_WORKSPACES).request('/agents?ws=all', { method: 'GET' });
  }

  /** One saved agent's `AgentRecord` - spec v2 plus meta, layout and the latest version - or undefined on a 404. */
  async loadAgent(agentId: string): Promise<AgentRecord | undefined> {
    try {
      return await this.request<AgentRecord>(`/agents/${encodeURIComponent(agentId)}`, { method: 'GET' });
    } catch (error) {
      if (error instanceof RuntimeApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  /** The agent's readiness rows on their own (`GET /agents/:id/requirements`) - the SuccessCard lists the still-missing ones after enabling. */
  async getAgentRequirements(agentId: string): Promise<Requirement[]> {
    return this.request(`/agents/${encodeURIComponent(agentId)}/requirements`, { method: 'GET' });
  }

  /** The agent's channel-trigger mount rows (`GET /agents/:id/triggers/status`, R08b) - URL + mount error per channel trigger. */
  async channelTriggerStatus(agentId: string): Promise<ChannelTriggerStatus[]> {
    return this.request(`/agents/${encodeURIComponent(agentId)}/triggers/status`, { method: 'GET' });
  }

  /** Writes `.lousho/agents/<id>.yaml` from a spec v2 working copy (`PUT /agents/:id` with a `{ spec }` body). */
  async saveAgent(agentId: string, spec: AgentSpecV2): Promise<void> {
    await this.request(`/agents/${encodeURIComponent(agentId)}`, {
      method: 'PUT',
      body: JSON.stringify({ spec }),
    });
  }

  /** Creates a blank agent or a copy (`POST /agents`) and answers its record. Named `createAgentRecord` so it never reads as the SDK's `createAgent` function. */
  async createAgentRecord(request: CreateAgentRequest): Promise<AgentRecord> {
    return this.request('/agents', { method: 'POST', body: JSON.stringify(request) });
  }

  /**
   * `POST /agents { from: { copyOf } }` (L10): duplicates the agent -
   * spec, labels and layout under `<id>-copy`, turned off - and answers
   * the copy's `AgentRecord`.
   */
  async duplicateAgent(agentId: string): Promise<AgentRecord> {
    return this.request('/agents', {
      method: 'POST',
      body: JSON.stringify({ from: { copyOf: agentId } }),
    });
  }

  /** Toggles `enabled` and/or stores the label set (`PATCH /agents/:id/meta`); answers the updated meta. */
  async patchAgentMeta(agentId: string, patch: PatchAgentMetaRequest): Promise<AgentMeta> {
    return this.request(`/agents/${encodeURIComponent(agentId)}/meta`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  /** Stores the canvas layout (`PUT /agents/:id/layout`) - node positions, notes and viewport. */
  async saveLayout(agentId: string, layout: CanvasLayout): Promise<void> {
    await this.request(`/agents/${encodeURIComponent(agentId)}/layout`, {
      method: 'PUT',
      body: JSON.stringify(layout),
    });
  }

  async deleteAgent(agentId: string): Promise<void> {
    await this.request(`/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' });
  }

  /** The agent's pending change draft as a `DraftView` (L11b), or `undefined` when it has none (the route answers 204). */
  async getDraft(agentId: string): Promise<DraftView | undefined> {
    return this.request<DraftView | undefined>(`/agents/${encodeURIComponent(agentId)}/draft`, {
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

  // -------------------------------------------------------------------
  // `/agents/:id/publish` - the publish pointer (L14a). See
  // server/lifecycle/publish.ts.
  // -------------------------------------------------------------------

  /**
   * Pins `version` (or the working copy's new `publish` version) as the
   * agent's published spec and answers the pinned version number. Idempotent:
   * pinning the already-published version is a no-op.
   */
  async publish(agentId: string, version?: number): Promise<{ publishedVersion: number }> {
    return this.request(`/agents/${encodeURIComponent(agentId)}/publish`, {
      method: 'POST',
      body: JSON.stringify(version === undefined ? {} : { version }),
    });
  }

  /** Records a 1-5 human rating on a run's trace (`POST /agents/:id/rating`, R04a). */
  async rateRun(agentId: string, body: RatingRequest): Promise<void> {
    await this.request(`/agents/${encodeURIComponent(agentId)}/rating`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /** Copies a low-rating alert's trace into the agent's `<agentId>-regressions` dataset (R04a). */
  // fallow-ignore-next-line unused-class-member -- contract surface: called on forWorkspace()-bound clients, which the member graph can't see
  async addAlertToDataset(agentId: string, alertId: string): Promise<{ dataset: string; exampleId: string }> {
    return this.request(`/agents/${encodeURIComponent(agentId)}/rating/${encodeURIComponent(alertId)}/dataset`, {
      method: 'POST',
    });
  }

  // -------------------------------------------------------------------
  // `/agents/:id/suggestions` - the prompt suggestions the Suggestions
  // tab lists and settles. See server/routes/suggestionRoutes.ts.
  // -------------------------------------------------------------------

  /** The agent's prompt suggestions: open first, then newest. */
  async listSuggestions(agentId: string): Promise<PromptSuggestion[]> {
    return this.request(`/agents/${encodeURIComponent(agentId)}/suggestions`, { method: 'GET' });
  }

  /**
   * Applies an open suggestion's anchored instructions edit and answers
   * the `source: 'suggestion'` version it wrote. 409 (keeping the
   * server's `code`) when it settled already, the instructions moved on
   * (`LOUSHO_SUGGESTION_CONFLICT`) or live in a file
   * (`LOUSHO_SUGGESTION_UNSUPPORTED`).
   */
  async applySuggestion(agentId: string, suggestionId: string): Promise<VersionListItem> {
    return this.request(
      `/agents/${encodeURIComponent(agentId)}/suggestions/${encodeURIComponent(suggestionId)}/apply`,
      { method: 'POST' }
    );
  }

  /** Dismisses an open suggestion - it stays in the list as `dismissed`. */
  async dismissSuggestion(agentId: string, suggestionId: string): Promise<void> {
    await this.request(
      `/agents/${encodeURIComponent(agentId)}/suggestions/${encodeURIComponent(suggestionId)}/dismiss`,
      { method: 'POST' }
    );
  }

  /**
   * "Suggest a fix" (R06): reserves a suggestion id and answers 202 while
   * the `prompt_suggestion` pass reads the trace's friction digest; the
   * record lands under `suggestions/<id>.json` (announced by the
   * `suggestion.new` event) when it finishes. 409 while one is already
   * in flight for the trace, 422 when the agent's instructions live in a
   * file (`LOUSHO_SUGGESTION_UNSUPPORTED`).
   */
  // fallow-ignore-next-line unused-class-member -- contract surface: called on forWorkspace()-bound clients, which the member graph can't see
  async suggestFromTrace(agentId: string, traceId: string): Promise<{ suggestionId: string }> {
    return this.request(`/agents/${encodeURIComponent(agentId)}/suggestions/from-trace`, {
      method: 'POST',
      body: JSON.stringify({ traceId }),
    });
  }

  /** The workspace the studio serves (`baseDir` is its root; `workspace` is the full ref for addressing it by id). */
  async workspace(): Promise<WorkspaceInfo> {
    return this.request('/workspace', { method: 'GET' });
  }

  /** X06a: a listed agent directory read back as an AgentSpecV2 (422 on code/unreadable configs). */
  async loadCodeAgentSpec(path: string): Promise<CodeAgentSpecResponse> {
    return this.request(`/workspace/agent-dirs/spec?path=${encodeURIComponent(path)}`, { method: 'GET' });
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

  /**
   * W08a: `id`'s cached code-agent scan (`GET /workspaces/:ws/scan`) -
   * scans on first read, then serves the stored result. Sent through
   * `forWorkspace(id)` so the workspace header matches the `:ws` path.
   */
  async workspaceScan(id: string): Promise<WorkspaceScanResult> {
    return this.forWorkspace(id).request(`/workspaces/${encodeURIComponent(id)}/scan`, { method: 'GET' });
  }

  /**
   * W08a: rescan `id`'s agent dirs (`POST /workspaces/:ws/scan`). When
   * `agentDirs` is given (1-20 glob patterns), the server persists them
   * on the workspace entry before scanning; omitted, the stored (or
   * default) patterns run again.
   */
  async scanWorkspace(id: string, agentDirs?: string[]): Promise<WorkspaceScanResult> {
    const body = agentDirs === undefined ? {} : { agentDirs };
    return this.forWorkspace(id).request(`/workspaces/${encodeURIComponent(id)}/scan`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /**
   * W11c: `id`'s host status (`GET /workspaces/:ws/host`) - which SDK runs
   * its agents, the selection banner, and the bridge child's state.
   */
  async hostStatus(id: string): Promise<HostStatus> {
    return this.forWorkspace(id).request(`/workspaces/${encodeURIComponent(id)}/host`, { method: 'GET' });
  }

  /**
   * W11c: restart `id`'s project bridge (`POST /workspaces/:ws/host/restart`)
   * - 202 with the settled status, or 409 `LOUSHO_HOST_NOT_BRIDGE`.
   */
  async restartHost(id: string): Promise<HostStatus> {
    return this.forWorkspace(id).request(`/workspaces/${encodeURIComponent(id)}/host/restart`, { method: 'POST' });
  }

  async run(
    agentId: string,
    input: string,
    spec: AgentSpecV2,
    pins?: ToolPin[]
  ): Promise<AgentRunStatusPayload> {
    return this.request(`/agents/${encodeURIComponent(agentId)}/run`, {
      method: 'POST',
      body: JSON.stringify({ input, spec, ...(pins !== undefined && pins.length > 0 ? { pins } : {}) }),
    });
  }

  /**
   * `POST /agents/:id/abort` - cancels the agent's active run (running or
   * paused on an approval) with an optional reason recorded on the status
   * payload's `abortReason` (abort listeners pass `'abort_listener:<id>'`).
   * A no-op 202 when nothing is running.
   */
  async abort(agentId: string, reason?: string): Promise<AgentRunStatusPayload> {
    return this.request(`/agents/${encodeURIComponent(agentId)}/abort`, {
      method: 'POST',
      body: JSON.stringify(reason === undefined ? {} : { reason }),
    });
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

  /**
   * Pushes `message` into the agent's live run input queue
   * (`POST /agents/:id/steer`, the SDK's `steer()` via the AgentHost).
   * Rejects with a `RuntimeApiError` - `code` 'LOUSHO_NO_ACTIVE_RUN' (409,
   * nothing running) or 'LOUSHO_STEER_UNSUPPORTED' (409, a flow run),
   * 'LOUSHO_BODY_INVALID' (400) - when the server refuses.
   */
  async steer(agentId: string, message: string): Promise<SteerResponse> {
    const body: SteerRequest = { message };
    return this.request(`/agents/${encodeURIComponent(agentId)}/steer`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /**
   * Answers a `kind: 'question'` pause (an `ask_question` call) - the same
   * `/approve` route as approve(), with `{ answer }` instead of
   * `{ approved }`; the server 400s the mismatched shape.
   */
  async answer(agentId: string, approvalId: string, answer: string): Promise<AgentRunStatusPayload> {
    return this.request(`/agents/${encodeURIComponent(agentId)}/approve`, {
      method: 'POST',
      body: JSON.stringify({ approvalId, answer }),
    });
  }

  /** Everything waiting on the user across this workspace's agents (R02a's `GET /inbox`). */
  // fallow-ignore-next-line unused-class-member -- contract surface: called on forWorkspace()-bound clients, which the member graph can't see
  async listInbox(): Promise<InboxItem[]> {
    return this.request('/inbox', { method: 'GET' });
  }

  /**
   * Every workspace's inbox items in one list (`GET /inbox?ws=all`, W09a):
   * bound to `ALL_WORKSPACES` like `listAllAgentItems` so the header can't
   * override the aggregate. Item ids are unique only inside a workspace -
   * key by `<workspaceId>/<id>`.
   */
  async listAllInbox(): Promise<WorkspaceInboxItem[]> {
    return this.forWorkspace(ALL_WORKSPACES).request('/inbox?ws=all', { method: 'GET' });
  }

  /** The inbox badge count (`GET /inbox/count`); also the `inbox.count` WS event's payload. */
  // fallow-ignore-next-line unused-class-member -- contract surface: public client API kept beside allInboxCount; tests pin it
  async inboxCount(): Promise<InboxCount> {
    return this.request('/inbox/count', { method: 'GET' });
  }

  /** The Studio-wide inbox total (`GET /inbox/count?ws=all`, W09a) - what the aggregate socket's `inbox.count` frame carries. */
  async allInboxCount(): Promise<number> {
    const body = await this.forWorkspace(ALL_WORKSPACES).request<InboxCount>('/inbox/count?ws=all', { method: 'GET' });
    return body.count;
  }

  /** Dismisses an undismissed inbox alert (`POST /inbox/alerts/:id/dismiss`). */
  // fallow-ignore-next-line unused-class-member -- contract surface: called on forWorkspace()-bound clients, which the member graph can't see
  async dismissAlert(alertId: string): Promise<void> {
    await this.request(`/inbox/alerts/${encodeURIComponent(alertId)}/dismiss`, { method: 'POST' });
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
  async sendMessage(agentId: string, message: string, spec?: AgentSpecV2): Promise<AgentRunStatusPayload> {
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

  /** The collector (observe daemon) status; `probe` re-checks the URL against the daemon first. */
  async collectorStatus(probe = false): Promise<CollectorStatus> {
    return this.request(`/settings/collector${probe ? '?probe=1' : ''}`, { method: 'GET' });
  }

  /** Persists a Settings → Collector change (`token` undefined keeps, null removes, a string sets the named secret). */
  async updateCollector(update: CollectorUpdate): Promise<CollectorStatus> {
    return this.request('/settings/collector', { method: 'PUT', body: JSON.stringify(update) });
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
  async probeMcp(server: McpServerSpecV2): Promise<McpProbeResponse> {
    const body: McpProbeRequest = { server };
    return this.request('/catalog/mcp/probe', { method: 'POST', body: JSON.stringify(body) });
  }

  // -------------------------------------------------------------------
  // `GET /templates*` - the SDK's shipped templates the Templates screen
  // (A10) and the New-agent "From template" menu (A04) read.
  // -------------------------------------------------------------------

  /** Every shipped template's summary (sorted by category then title). */
  async listTemplates(): Promise<TemplateSummary[]> {
    return this.request('/templates', { method: 'GET' });
  }

  /** One template's detail - summary, spec v2 and README; undefined on a 404. */
  async getTemplate(id: string): Promise<TemplateDetail | undefined> {
    try {
      return await this.request<TemplateDetail>(`/templates/${encodeURIComponent(id)}`, { method: 'GET' });
    } catch (error) {
      if (error instanceof RuntimeApiError && error.status === 404) return undefined;
      throw error;
    }
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
   * `GET /agents/:id/export?format=yaml|bundle` (L07) as a Blob plus the
   * server's `Content-Disposition` filename and the bundle's
   * `X-Lousho-Export-Warnings` list (empty for YAML and a clean bundle).
   */
  async downloadExport(
    agentId: string,
    format: 'yaml' | 'bundle',
    opts?: { adapt?: boolean }
  ): Promise<{ blob: Blob; filename: string; warnings: string[] }> {
    const adapt = opts?.adapt === true ? '&adapt=1' : '';
    const res = await this.fetch(`/agents/${encodeURIComponent(agentId)}/export?format=${format}${adapt}`, { method: 'GET' });
    if (!res.ok) {
      const body = await res.json().catch(() => undefined);
      throw apiError(body, `Export of '${agentId}' failed with ${res.status}`, res.status);
    }
    const disposition = res.headers.get('Content-Disposition') ?? '';
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1]
      ?? (format === 'yaml' ? `${agentId}.yaml` : `${agentId}.lousho-agent.json`);
    const warningsHeader = res.headers.get('X-Lousho-Export-Warnings');
    let warnings: string[] = [];
    if (warningsHeader !== null) {
      try {
        const parsed: unknown = JSON.parse(decodeURIComponent(warningsHeader));
        if (Array.isArray(parsed)) warnings = parsed.filter((w): w is string => typeof w === 'string');
      } catch {
        // A malformed warnings header degrades to no warnings, never a failed download.
      }
    }
    return { blob: await res.blob(), filename, warnings };
  }

  /**
   * `POST /agents/import/preview` (L08a): parses pasted YAML/JSON/bundle
   * text and answers what the import would write - clash, resolved id,
   * requirements, prompts and warnings - without writing anything.
   */
  async previewImport(request: ImportRequest): Promise<ImportPreview> {
    return this.request<ImportPreview>('/agents/import/preview', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  /**
   * `POST /agents/import` (L08a): writes the pasted spec in `request.mode`
   * (`new`/`copy` answer 201, `replace` 200) and answers the `AgentRecord`.
   */
  async importAgent(request: ImportRequest): Promise<AgentRecord> {
    return this.request<AgentRecord>('/agents/import', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  /**
   * `POST /agents/:id/portability` (L09a): runs the portability check pass
   * for an agent (cached server-side by spec hash) and answers the
   * `PortabilityAnalysis` - findings plus the `[YOUR …]`-adapted
   * instructions an `adapt=1` export substitutes.
   */
  async checkPortability(agentId: string): Promise<PortabilityAnalysis> {
    return this.request<PortabilityAnalysis>(`/agents/${encodeURIComponent(agentId)}/portability`, {
      method: 'POST',
      body: '{}',
    });
  }

  /**
   * `POST /agents/import/portability` (L09a): runs the same check on
   * pasted YAML/JSON/bundle text (parsed like `previewImport`) before the
   * agent exists; the analysis caches in memory server-side.
   */
  async checkImportPortability(text: string): Promise<PortabilityAnalysis> {
    return this.request<PortabilityAnalysis>('/agents/import/portability', {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
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
    return this.subscribeJson(`/agents/${encodeURIComponent(agentId)}/stream`, onMessage, connection, onError);
  }

  // -------------------------------------------------------------------
  // `/assistant/*` - the Agent Author's chat sessions, settings and live
  // turn stream (server/author/**). The panel (AA15) talks only through
  // these.
  // -------------------------------------------------------------------

  /** Starts an Author chat (`POST /assistant/sessions`); `focus` omitted defaults server-side to "new agent". */
  async createAuthorSession(focus?: AuthorFocus): Promise<AuthorSession> {
    return this.request('/assistant/sessions', { method: 'POST', body: JSON.stringify({ focus }) });
  }

  /** The chat history list (`GET /assistant/sessions`), newest first. */
  async listAuthorSessions(): Promise<AuthorSessionSummary[]> {
    return this.request('/assistant/sessions', { method: 'GET' });
  }

  /**
   * One Author chat with its transcript (`GET /assistant/sessions/:id`);
   * rejects on 404. `runningRequestId` names the in-flight reply's
   * requestId, when one is running (the reattach decision).
   */
  async getAuthorSession(id: string): Promise<AuthorSessionRecord> {
    return this.request(`/assistant/sessions/${encodeURIComponent(id)}`, { method: 'GET' });
  }

  /** Deletes an Author chat (`DELETE /assistant/sessions/:id`); rejects on 404/409. */
  async deleteAuthorSession(id: string): Promise<void> {
    await this.request(`/assistant/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  /**
   * The proposal card's Apply button (`POST /assistant/sessions/:id/save`):
   * writes exactly the stored card's spec and answers the save result plus
   * the appended `uiEvent` user message. Rejects with a `RuntimeApiError`
   * whose `code`/`details` carry the refusal (`STALE_PROPOSAL` +
   * `details.latestProposalId`, `ALREADY_SAVED`, `BUSY`, ...).
   */
  async saveProposal(sessionId: string, proposalId: string): Promise<AuthorSaveResponse> {
    return this.request(`/assistant/sessions/${encodeURIComponent(sessionId)}/save`, {
      method: 'POST',
      body: JSON.stringify({ proposalId }),
    });
  }

  /**
   * The SecretCard's submit (`POST /assistant/sessions/:id/secret`,
   * AA14): `body.value` goes straight to the secrets store server-side -
   * it never enters the transcript, the WS stream, or anything this
   * client receives back. Resolves on 204; rejects with a
   * `RuntimeApiError` whose `code` carries the refusal (`NOT_PENDING`,
   * `BUSY`, `INVALID_INPUT`, `NOT_FOUND`).
   */
  async submitAuthorSecret(sessionId: string, body: AuthorSecretRequest): Promise<void> {
    await this.request(`/assistant/sessions/${encodeURIComponent(sessionId)}/secret`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /**
   * The SuccessCard's "Enable agent" button (`POST
   * /assistant/sessions/:id/enable`): flips `meta.enabled` for an agent
   * this chat created, without a model turn. Rejects with a
   * `RuntimeApiError` on `WRONG_AGENT` (the chat did not create it),
   * `AGENT_NOT_FOUND`, or a session 404.
   */
  async enableAuthorAgent(sessionId: string, agentId: string): Promise<SetEnabledOutput> {
    return this.request(`/assistant/sessions/${encodeURIComponent(sessionId)}/enable`, {
      method: 'POST',
      body: JSON.stringify({ agentId }),

    });
  }

  /** The Author's model choices plus `ready`/`missingKeyFor` (`GET /settings/author`). */
  async getAuthorSettings(): Promise<AuthorSettingsPayload> {
    return this.request('/settings/author', { method: 'GET' });
  }

  /**
   * Patches the Author's model choices (`PUT /settings/author`) and
   * answers the effective settings - the response also recomputes
   * `ready`/`missingKeyFor`, so a model swap can flip the SetupCard.
   * Rejects with the server's `{ error }` (400 `INVALID_INPUT` for a
   * `model` that is not `provider/model`).
   */
  async saveAuthorSettings(patch: Partial<AuthorSettings>): Promise<AuthorSettingsPayload> {
    return this.request('/settings/author', { method: 'PUT', body: JSON.stringify(patch) });
  }

  /** The background passes' model choices and per-kind switches (`GET /settings/passes`, L06b). */
  async getPassSettings(): Promise<PassSettings> {
    return this.request('/settings/passes', { method: 'GET' });
  }

  /**
   * Patches the pass settings (`PUT /settings/passes`) and answers the
   * effective settings. Rejects with the server's `{ error }` (400 for a
   * `model` that is not `provider/model` or an unknown `enabled` kind).
   */
  async savePassSettings(patch: PassSettingsPatch): Promise<PassSettings> {
    return this.request('/settings/passes', { method: 'PUT', body: JSON.stringify(patch) });
  }

  /** This window's pass spend rollup (`GET /settings/passes/spend?month=YYYY-MM`, L06a). */
  async getPassSpend(month?: string): Promise<PassSpendSummary> {
    const query = month === undefined ? '' : `?month=${encodeURIComponent(month)}`;
    return this.request(`/settings/passes/spend${query}`, { method: 'GET' });
  }

  /**
   * `WS /assistant/stream?session=<id>&token=<token>` - the raw socket
   * `connectAuthorStream` (src/author/authorStream.ts) wraps with reconnects.
   */
  openAuthorSocket(sessionId: string): WebSocket {
    const query = new URLSearchParams({ session: sessionId });
    if (this.token) query.set('token', this.token);
    return new WebSocket(`${this.wsBaseUrl()}${AUTHOR_STREAM_PATH}?${query}`);
  }

  /**
   * Subscribes to `WS /events`, the Studio-wide event bus (the server's
   * per-workspace `StudioEventBus` fanned out to every tab). Returns an
   * unsubscribe function. Like `subscribe()`, reconnects are the caller's
   * job (`connection.onLost`) - `useStudioEvents` is that caller.
   */
  subscribeEvents(
    onEvent: (event: StudioEvent) => void,
    connection?: StreamConnectionHandlers
  ): () => void {
    return this.subscribeJson('/events', onEvent, connection);
  }

  /**
   * Subscribes to `WS /events?ws=all` (W09a): every workspace's
   * `StudioEvent` tagged with its `workspaceId`, plus the Studio-wide
   * `{ type: 'inbox.count', workspaceId: 'all' }` total. Bound to
   * `ALL_WORKSPACES` so the socket's `?ws=` can't be overridden by the
   * URL's workspace.
   */
  subscribeAllEvents(
    onFrame: (frame: AllEventsFrame) => void,
    connection?: StreamConnectionHandlers
  ): () => void {
    return this.forWorkspace(ALL_WORKSPACES).subscribeJson('/events', onFrame, connection);
  }
}

export { RuntimeClient };
export const runtimeClient = new RuntimeClient();
