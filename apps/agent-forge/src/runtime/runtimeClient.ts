/**
 * Browser-side client for the LOU-N runtime control server
 * (apps/agent-forge/server/**). Talks to it over plain `fetch` for
 * run/stop/status/approve and a `WebSocket` for the live status/event
 * stream - this is the app's only dependency on the server's wire shape,
 * so the two can evolve together without every component knowing the HTTP
 * details.
 */
import type { AgentSpec } from '@loushy/build-ai-agent';
import type {
  AgentRunStatusPayload,
  ChatSessionMeta,
  ChatSessionRecord,
  ChatStatePayload,
  DebugStatePayload,
  DeployResult,
  ProviderKeyStatus,
  SettingsFile,
  SettingsProfile,
  StreamMessage,
} from '../../shared/wireTypes';

/** Same-origin default: `loushy studio` prints the API server's own URL, but in dev the Vite server proxies to it (see vite.config.ts). */
const DEFAULT_BASE_URL = '';

interface RuntimeClientOptions {
  baseUrl?: string;
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

  constructor(options: RuntimeClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  }

  private wsBaseUrl(): string {
    if (this.baseUrl) {
      return this.baseUrl.replace(/^http/, 'ws');
    }
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}`;
  }

  private async request(path: string, init?: RequestInit): Promise<AgentRunStatusPayload> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
    const body = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    if (!res.ok) {
      throw apiError(body, `Request to ${path} failed with ${res.status}`, res.status);
    }
    return body as AgentRunStatusPayload;
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
    const res = await fetch(`${this.baseUrl}/agents/${encodeURIComponent(agentId)}/debug`);
    return (await res.json()) as DebugStatePayload;
  }

  async setBreakpoints(agentId: string, breakpoints: string[]): Promise<DebugStatePayload> {
    const res = await fetch(`${this.baseUrl}/agents/${encodeURIComponent(agentId)}/debug/breakpoints`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ breakpoints }),
    });
    return (await res.json()) as DebugStatePayload;
  }

  async continueRun(agentId: string): Promise<DebugStatePayload> {
    const res = await fetch(`${this.baseUrl}/agents/${encodeURIComponent(agentId)}/debug/continue`, { method: 'POST' });
    return (await res.json()) as DebugStatePayload;
  }

  async stepRun(agentId: string): Promise<DebugStatePayload> {
    const res = await fetch(`${this.baseUrl}/agents/${encodeURIComponent(agentId)}/debug/step`, { method: 'POST' });
    return (await res.json()) as DebugStatePayload;
  }

  /** P1: sends a chat message - continues the agent's conversation (or starts one), replying over the WS `subscribe()` stream as `{type:'chat'}`. */
  async sendMessage(agentId: string, message: string): Promise<AgentRunStatusPayload> {
    return this.request(`/agents/${encodeURIComponent(agentId)}/message`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
  }

  /** P1: REST snapshot of the current live chat transcript (mirrors the WS stream's initial `{type:'chat'}` push). */
  async getChat(agentId: string): Promise<ChatStatePayload> {
    const res = await fetch(`${this.baseUrl}/agents/${encodeURIComponent(agentId)}/chat`);
    return (await res.json()) as ChatStatePayload;
  }

  /** P3: archives the current chat session and starts a fresh, empty one. */
  async newChat(agentId: string): Promise<ChatStatePayload> {
    const res = await fetch(`${this.baseUrl}/agents/${encodeURIComponent(agentId)}/chat/new`, { method: 'POST' });
    return (await res.json()) as ChatStatePayload;
  }

  /** P3: metadata for every past (and current) chat session for `agentId`, newest first. */
  async listChats(agentId: string): Promise<ChatSessionMeta[]> {
    const res = await fetch(`${this.baseUrl}/agents/${encodeURIComponent(agentId)}/chats`);
    return (await res.json()) as ChatSessionMeta[];
  }

  /** P3: a full past chat session's transcript. */
  async loadChatSession(agentId: string, sessionId: string): Promise<ChatSessionRecord> {
    const res = await fetch(`${this.baseUrl}/agents/${encodeURIComponent(agentId)}/chats/${encodeURIComponent(sessionId)}`);
    if (!res.ok) {
      const body = await res.json().catch(() => undefined);
      throw apiError(body, `Failed to load chat session '${sessionId}'`, res.status);
    }
    return (await res.json()) as ChatSessionRecord;
  }

  /** R1: masked status of every managed provider's stored key. */
  async listProviderKeys(): Promise<ProviderKeyStatus[]> {
    const res = await fetch(`${this.baseUrl}/settings/providers`);
    return (await res.json()) as ProviderKeyStatus[];
  }

  /** R1: stores (or replaces) `provider`'s API key. Resolves with the new masked status - never the real key. */
  async setProviderKey(provider: string, apiKey: string): Promise<ProviderKeyStatus> {
    const res = await fetch(`${this.baseUrl}/settings/providers/${encodeURIComponent(provider)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    });
    const body = await res.json().catch(() => undefined);
    if (!res.ok) throw apiError(body, `Failed to set key for '${provider}'`, res.status);
    return body as ProviderKeyStatus;
  }

  /** R1: removes `provider`'s stored key, if any. */
  async removeProviderKey(provider: string): Promise<void> {
    await fetch(`${this.baseUrl}/settings/providers/${encodeURIComponent(provider)}`, { method: 'DELETE' });
  }

  /** R3: every settings profile + which one is active. */
  async listSettingsProfiles(): Promise<SettingsFile> {
    const res = await fetch(`${this.baseUrl}/settings/profiles`);
    return (await res.json()) as SettingsFile;
  }

  /** R3: creates or replaces a profile by id. */
  async saveSettingsProfile(profile: SettingsProfile): Promise<SettingsFile> {
    const res = await fetch(`${this.baseUrl}/settings/profiles/${encodeURIComponent(profile.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profile),
    });
    const body = await res.json().catch(() => undefined);
    if (!res.ok) throw apiError(body, 'Failed to save settings profile', res.status);
    return body as SettingsFile;
  }

  /** R3: deletes a profile (refuses to delete the last remaining one). */
  async deleteSettingsProfile(profileId: string): Promise<SettingsFile> {
    const res = await fetch(`${this.baseUrl}/settings/profiles/${encodeURIComponent(profileId)}`, { method: 'DELETE' });
    const body = await res.json().catch(() => undefined);
    if (!res.ok) throw apiError(body, 'Failed to delete settings profile', res.status);
    return body as SettingsFile;
  }

  /** R3: switches the active profile. */
  async activateSettingsProfile(profileId: string): Promise<SettingsFile> {
    const res = await fetch(`${this.baseUrl}/settings/profiles/${encodeURIComponent(profileId)}/activate`, { method: 'POST' });
    const body = await res.json().catch(() => undefined);
    if (!res.ok) throw apiError(body, 'Failed to activate settings profile', res.status);
    return body as SettingsFile;
  }

  /** R2: deploy-target names this app's Settings dropdown offers - see server/deployRunner.ts's DEPLOY_ADAPTERS. */
  async listDeployAdapters(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/settings/deploy-adapters`);
    return (await res.json()) as string[];
  }

  /** R2: "Deploy this agent" - shells out to `loushy build --target=<adapter>` against this agent's saved spec. */
  async deployAgent(agentId: string, adapter: string): Promise<DeployResult> {
    const res = await fetch(`${this.baseUrl}/agents/${encodeURIComponent(agentId)}/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adapter }),
    });
    return (await res.json()) as DeployResult;
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
    const ws = new WebSocket(`${this.wsBaseUrl()}/agents/${encodeURIComponent(agentId)}/stream`);
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

export const runtimeClient = new RuntimeClient();
