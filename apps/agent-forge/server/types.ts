/**
 * LOU-N runtime control server - shared types.
 *
 * The server holds an in-memory registry mapping agent IDs to live
 * `AgentExecutor.execute()` invocations (see runRegistry.ts). This file
 * defines the wire shape of the status/events the server reports back to
 * the app over `GET /agents/:id/status` and `WS /agents/:id/stream`.
 */

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
   * `ExecutionResult`) since this file is also mirrored client-side
   * (src/runtime/runtimeClient.ts) where it's rendered generically.
   */
  result?: unknown;
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
 * `ExecutionEvent.type` (see runRegistry.ts's `toLogEntries()`), extended
 * with 'sandbox'/'checkpoint'/'debug' for events the raw ExecutionEvent
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
 * A single WS message pushed to `WS /agents/:id/stream` subscribers.
 * `type: 'status'` carries the full AgentRunStatusPayload (sent on every
 * status transition, and once immediately on connect). `type: 'event'`
 * forwards a raw AgentExecutor ExecutionEvent (start/text-complete/tool-call/
 * tool-result/finish/error) for lightweight visibility into an in-progress
 * run. `type: 'log'`/`'span'`/`'debug'` are LOU-O's structured log stream
 * (O1), span waterfall (O2) and step-debugger state (O3), all derived from
 * the same run rather than a second parallel event system.
 */
export type StreamMessage =
  | { type: 'status'; payload: AgentRunStatusPayload }
  | { type: 'event'; payload: Record<string, unknown> }
  | { type: 'log'; payload: LogEntry }
  | { type: 'span'; payload: SpanEvent }
  | { type: 'debug'; payload: DebugStatePayload };

/**
 * Every `:id`/agentId this server touches ends up interpolated into a
 * filesystem path (`.loushy/agents/<id>.yaml`, `.loushy/agents/<id>/checkpoints/**`,
 * `.loushy/agents/<id>/approvals/**` - see fsAgentStore.ts, checkpointStore.ts,
 * approvalStore.ts) with no further sanitization there. Express route
 * params are URL-decoded before `req.params.id` is populated, so a
 * percent-encoded `..%2F..%2Fsomewhere` arrives as a plain string containing
 * `/` and `..` segments - path.join() will happily walk it outside
 * `.loushy/agents/`. Restrict every accepted id up front (here, and in
 * wsServer.ts's WS upgrade handler, which parses `:id` itself rather than
 * going through Express routing) to a safe, single-path-segment token
 * instead of trying to sanitize/escape it later in each store.
 */
const AGENT_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/;

export function isValidAgentId(id: string): boolean {
  return typeof id === 'string' && AGENT_ID_RE.test(id) && !id.includes('..');
}
