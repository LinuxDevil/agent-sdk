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
  updatedAt: string;
}

/**
 * A single WS message pushed to `WS /agents/:id/stream` subscribers.
 * `type: 'status'` carries the full AgentRunStatusPayload (sent on every
 * status transition, and once immediately on connect). `type: 'event'`
 * forwards a raw AgentExecutor ExecutionEvent (start/text-complete/tool-call/
 * tool-result/finish/error) for lightweight visibility into an in-progress
 * run - the full log/trace UI is LOU-O's job, this is best-effort forwarding
 * only, not a durable log.
 */
export type StreamMessage =
  | { type: 'status'; payload: AgentRunStatusPayload }
  | { type: 'event'; payload: Record<string, unknown> };

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
