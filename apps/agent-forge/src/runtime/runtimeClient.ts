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
  /** O4: full ExecutionResult (messages/toolCalls/usage/steps/finishReason) once a run completes or pauses. */
  result?: unknown;
  updatedAt: string;
}

export type LogLevel = 'info' | 'warn' | 'error' | 'tool';
export type LogPhase = 'trigger' | 'llm' | 'tool' | 'sandbox' | 'checkpoint' | 'approval' | 'debug';

export interface LogEntry {
  id: string;
  agentId: string;
  timestamp: string;
  level: LogLevel;
  phase: LogPhase;
  toolName?: string;
  message: string;
  detail?: unknown;
}

export interface SpanEvent {
  id: string;
  name: string;
  parentId?: string;
  startTime: number;
  endTime?: number;
  attributes: Record<string, unknown>;
}

export interface DebugStatePayload {
  agentId: string;
  paused: boolean;
  atBreakpoint?: { phase: string; boundary: 'before' | 'after' };
  messages: unknown[];
  stepCount: number;
  breakpoints: string[];
}

/**
 * P1/P2: one message in the chat thread - mirrors the server's `ChatMessage`
 * (server/types.ts), itself a 1:1 mapping of the SDK's real `Message`
 * (src/providers/llm.ts) plus `id`/`timestamp` for React keys and the
 * mockup's per-bubble timestamp. `role: 'system'` messages are part of the
 * real conversation but are filtered out of the rendered bubble list by
 * ChatPanel, matching the mockup (user/agent bubbles only).
 */
export interface ChatMessage {
  id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  timestamp: string;
}

export interface ChatStatePayload {
  agentId: string;
  sessionId: string;
  messages: ChatMessage[];
}

export interface ChatSessionMeta {
  sessionId: string;
  startedAt: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
}

export interface ChatSessionRecord extends ChatSessionMeta {
  messages: ChatMessage[];
}

export type StreamMessage =
  | { type: 'status'; payload: AgentRunStatusPayload }
  | { type: 'event'; payload: Record<string, unknown> }
  | { type: 'log'; payload: LogEntry }
  | { type: 'span'; payload: SpanEvent }
  | { type: 'debug'; payload: DebugStatePayload }
  | { type: 'chat'; payload: ChatStatePayload };

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
      throw new RuntimeApiError((body && body.error) || `Failed to load chat session '${sessionId}'`, res.status);
    }
    return (await res.json()) as ChatSessionRecord;
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
