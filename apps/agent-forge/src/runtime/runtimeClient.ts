/**
 * Browser-side client for the LOU-N runtime control server
 * (apps/agent-forge/server/**). Talks to it over plain `fetch` for
 * run/stop/status/approve and a `WebSocket` for the live status/event
 * stream - this is the app's only dependency on the server's wire shape,
 * so the two can evolve together without every component knowing the HTTP
 * details.
 */
import type { AgentSpec } from '@loushy/build-ai-agent';

export type RunStatus = 'idle' | 'running' | 'stopped' | 'error' | 'paused';

export interface PendingApprovalInfo {
  approvalId: string;
  toolName: string;
  args: Record<string, unknown>;
  createdAt: string;
}

export interface AgentRunStatusPayload {
  agentId: string;
  status: RunStatus;
  sessionId?: string;
  reason?: 'awaiting_approval';
  pendingApproval?: PendingApprovalInfo;
  error?: string;
  resultText?: string;
  updatedAt: string;
}

export type StreamMessage =
  | { type: 'status'; payload: AgentRunStatusPayload }
  | { type: 'event'; payload: Record<string, unknown> };

/** Same-origin default: `loushy studio` prints the API server's own URL, but in dev the Vite server proxies to it (see vite.config.ts). */
const DEFAULT_BASE_URL = '';

export interface RuntimeClientOptions {
  baseUrl?: string;
}

export class RuntimeApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

export class RuntimeClient {
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
      throw new RuntimeApiError((body && body.error) || `Request to ${path} failed with ${res.status}`, res.status);
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
