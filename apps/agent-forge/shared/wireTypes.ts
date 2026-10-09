/**
 * LOU-N runtime control server - shared wire types.
 *
 * Single source of truth for the shapes exchanged between the server
 * (apps/agent-forge/server/**) and the browser client
 * (src/runtime/runtimeClient.ts); both import this module.
 *
 * The server holds an in-memory registry mapping agent IDs to live
 * `AgentExecutor.execute()` invocations (see runRegistry.ts). This file
 * defines the wire shape of the status/events the server reports back to
 * the app over `GET /agents/:id/status` and `WS /agents/:id/stream`.
 */
import type { CheckpointStatus, TrajectoryComparison, TrajectoryStep } from '@lousho/build-ai-agent';

/**
 * Status pill states the app's agent list / topbar render (LOU-L/M's
 * mockup: running/stopped/error/paused).
 */
export type RunStatus = 'idle' | 'running' | 'stopped' | 'error' | 'paused';

/**
 * A tool call an in-progress run is paused on, awaiting a human decision
 * via `POST /agents/:id/approve`. Mirrors the subset of
 * `PendingApproval` (src/execution/ApprovalGate.ts) the UI needs to render
 * an inline approve/reject card, without leaking the full ExecutionSnapshot.
 */
export interface PendingApprovalInfo {
  approvalId: string;
  toolName: string;
  args: Record<string, unknown>;
  createdAt: string;
}

/**
 * The full status record the server keeps per agent ID and reports back to
 * the client (REST snapshot + WS push).
 */
export interface AgentRunStatusPayload {
  agentId: string;
  status: RunStatus;
  sessionId?: string;
  /** Set when status === 'paused' because of a pending tool approval. */
  reason?: 'awaiting_approval';
  pendingApproval?: PendingApprovalInfo;
  /** Set when status === 'error'. */
  error?: string;
  /** Final assistant text, once a run completes successfully. */
  resultText?: string;
  /**
   * O4: the full `ExecutionResult` (src/execution/AgentExecutor.ts -
   * `messages`/`toolCalls`/`usage`/`steps`/`finishReason`, not just the
   * final text) once a run completes OR pauses for approval - the Output
   * tab's JSON tree source. `unknown` here (rather than importing
   * `ExecutionResult`) since this module is also used client-side
   * (src/runtime/runtimeClient.ts) where it's rendered generically.
   */
  result?: unknown;
  /** Eve DUI-F4: `<provider>/<model>` the latest run actually used (e.g. `openai/gpt-4o-mini`, `mock/mock-1`). */
  provider?: string;
  updatedAt: string;
}

/**
 * O1: structured log line severity, shown in the Logs tab's filter bar.
 * `tool` is its own level (not folded into `info`) so the filter bar can
 * isolate tool activity the way the mockup's log rows do.
 */
export type LogLevel = 'info' | 'warn' | 'error' | 'tool';

/**
 * O1: which part of the run a log line came from - reuses the same
 * taxonomy the mockup's log rows are tagged with. Derived from
 * `AgentEvent.type` (see logEntries.ts's `toLogEntries()`), extended
 * with 'sandbox'/'checkpoint'/'debug' for events the AgentEvent
 * stream doesn't carry a dedicated type for.
 */
export type LogPhase = 'trigger' | 'llm' | 'tool' | 'sandbox' | 'checkpoint' | 'approval' | 'debug';

export interface LogEntry {
  id: string;
  agentId: string;
  timestamp: string;
  level: LogLevel;
  phase: LogPhase;
  /** Tool name, when `phase === 'tool'`. */
  toolName?: string;
  message: string;
  detail?: unknown;
}

/**
 * O2: one span lifecycle notification, forwarded verbatim (real
 * `Date.now()` timestamps, not synthetic ones) from the SDK's
 * `TraceExporter.onSpanStart`/`onSpanEnd` (src/execution/tracing.ts).
 */
export interface SpanEvent {
  id: string;
  name: string;
  parentId?: string;
  startTime: number;
  endTime?: number;
  attributes: Record<string, unknown>;
  /** M5b: `internal` or `client` (a model call). */
  kind?: 'internal' | 'client';
  /** M5b: `error` when the span failed. */
  status?: { code: 'ok' | 'error'; message?: string };
}

/** M5b: one persisted run in `GET /agents/:id/traces` (the SDK's `TraceSummary` without the server-side file path). */
export interface TraceSummaryPayload {
  traceId: string;
  name: string;
  agent?: string;
  startTime: number;
  durationMs: number;
  status: 'ok' | 'error';
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

/** M5b: `GET /agents/:id/traces/:traceId`. */
export interface TraceDetailPayload {
  traceId: string;
  spans: SpanEvent[];
}

/**
 * O3: live step-through debugger state for one agent's run (see
 * debugController.ts for exactly what "paused"/"breakpoint" mean given
 * AgentExecutor's real control surface).
 */
export interface DebugStatePayload {
  agentId: string;
  paused: boolean;
  atBreakpoint?: { phase: string; boundary: 'before' | 'after' };
  messages: unknown[];
  stepCount: number;
  breakpoints: string[];
}

/**
 * P1/P2: one message in the chat thread, mapped 1:1 from the SDK's real
 * `Message` (src/providers/llm.ts) rather than a separate invented shape -
 * only `id`/`timestamp` are added (the SDK's `Message` carries neither),
 * for React keys and the mockup's per-bubble timestamp. `role: 'system'`
 * messages are included for completeness (they're part of the real
 * conversation AgentExecutor sees) but the client filters them out of the
 * rendered bubble list, matching the mockup (which only ever shows
 * user/agent bubbles).
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

/** P1: the live chat transcript for one agent's current session, pushed over WS and returned by `GET /agents/:id/chat`. */
export interface ChatStatePayload {
  agentId: string;
  sessionId: string;
  messages: ChatMessage[];
}

/** P3: metadata for one past (or current) chat session, as listed by `GET /agents/:id/chats`. */
export interface ChatSessionMeta {
  sessionId: string;
  startedAt: string;
  updatedAt: string;
  messageCount: number;
  /** Truncated text of the first user message, for a browsable session list. */
  preview: string;
}

/** P3: a full past chat session, as returned by `GET /agents/:id/chats/:sessionId`. */
export interface ChatSessionRecord extends ChatSessionMeta {
  messages: ChatMessage[];
}

/**
 * A single WS message pushed to `WS /agents/:id/stream` subscribers.
 * `type: 'status'` carries the full AgentRunStatusPayload (sent on every
 * status transition, and once immediately on connect). `type: 'event'`
 * forwards one of the run's `AgentEvent`s (run.start/text.done/tool.start/
 * tool.done/run.done/...) for lightweight visibility into an in-progress
 * run. `type: 'log'`/`'span'`/`'debug'` are LOU-O's structured log stream
 * (O1), span waterfall (O2) and step-debugger state (O3), all derived from
 * the same run rather than a second parallel event system. `type: 'chat'`
 * (P1) is the live chat transcript, sent on every reconciled update and
 * once immediately on connect (mirroring 'status').
 */
export type StreamMessage =
  | { type: 'status'; payload: AgentRunStatusPayload }
  | { type: 'event'; payload: Record<string, unknown> }
  | { type: 'log'; payload: LogEntry }
  | { type: 'span'; payload: SpanEvent }
  | { type: 'debug'; payload: DebugStatePayload }
  | { type: 'chat'; payload: ChatStatePayload };

/** R1: masked provider key status. Never carries a real key. */
export interface ProviderKeyStatus {
  provider: 'openai' | 'anthropic';
  hasKey: boolean;
  /** Last-4-visible masked form for display, e.g. '••••••••3f2a'. `null` when no key is stored. Never the real key. */
  masked: string | null;
}

/**
 * LOU-Q's hardcoded 5s hook-sandbox timeout, now configurable per profile
 * (see hookSandbox.ts's `HookSandboxOptions.timeoutMs`). The sandbox
 * BACKEND stays NoopSandbox-only: `src/security/sandboxCore.ts` (the only
 * SandboxAdapter this SDK ships today) exports just `NoopSandbox` - there is
 * no second real adapter (e.g. a Docker-backed one) yet to offer a picker
 * over, so `sandboxBackend` here is a single-valued field reserved for when
 * one exists rather than a dropdown with one option pretending to be a choice.
 */
export interface SettingsProfile {
  id: string;
  name: string;
  /** Matches an `AgentSpec.provider.type` value ('mock' | 'openai' | 'anthropic' | 'ollama' | 'openrouter'). */
  providerType: string;
  /** Which `secretsStore` provider's stored key to use when `providerType` is one of `SECRET_PROVIDERS` ('openai' | 'anthropic'). `undefined` for 'mock'/'ollama'/'openrouter' (env-var/no-key providers). */
  providerKeyRef?: string;
  /** Deploy target name - see `src/deploy/index.ts`'s `registerBuiltInAdapters()` for the real registered names this must match. */
  deployAdapter: string;
  /** Opt-in bundled OTel export toggle (LOU-R's brief: ADDITIONALLY export to a real collector via `src/execution/otel.ts`'s `createOtelTraceExporter()`, not a replacement for LOU-O's own trace panel). */
  otelEnabled: boolean;
  /** Passed through to `hookSandbox.ts`'s `sandboxRunHook()` as `timeoutMs`. */
  hookTimeoutMs: number;
  sandboxBackend: 'noop';
}

export interface SettingsFile {
  activeProfileId: string;
  profiles: SettingsProfile[];
}

/** R2: `POST /agents/:id/deploy`'s result - the shelled-out `lousho build` child process's outcome. */
export interface DeployResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  command: string;
}

/**
 * LOU-D45: one step of a run's checkpoint history (`GET /runs/:id/history`,
 * where a run id is the session id: the agent id, or a fork's id) - the
 * newest checkpoint saved at that step of the latest execution.
 */
export interface RunHistoryStep {
  step: number;
  status: CheckpointStatus;
  savedAt: string;
  /** The model's finish reason for this step: `tool_calls` when it called tools, else as recorded. */
  finishReason?: string;
  /** The step's tool calls; `result` is absent while a call has none. */
  toolCalls: TrajectoryStep['tools'];
  /** This step's model call, when its usage (and price) is known. */
  tokens?: number;
  costUsd?: number;
}

export interface RunHistoryPayload {
  runId: string;
  steps: RunHistoryStep[];
}

/** LOU-D45: `POST /runs/:id/fork` body - see `ForkPatch` (src/execution/checkpoint.ts). */
export interface ForkRunRequest {
  fromStep: number;
  patch?: { toolResult?: { toolCallId: string; result: unknown }; appendInput?: string; businessState?: unknown };
}

/** LOU-D45: the started fork; its live status streams on `WS /agents/<runId>/stream`. */
export interface ForkRunResponse {
  runId: string;
  fromStep: number;
  status: AgentRunStatusPayload;
}

/** LOU-D45: `GET /runs/compare?a=&b=` - `compareTrajectories(a, b)`. */
export type RunComparisonPayload = TrajectoryComparison;
