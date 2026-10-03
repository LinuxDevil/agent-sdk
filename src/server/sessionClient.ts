/**
 * LOU-D53: the one client for a deployed agent's session API (`POST <url>/chat`, SSE answer, bearer auth), and (LOU-Y7.3)
 * its approvals route (`POST <url>/chat/:sessionId/approvals/:id`, the continuation streamed). Fetch only, Worker-safe.
 */
import type { AgentEvent, AgentEventOf, AgentEventUsage } from '../execution/agentEvents';
import { SDKError } from '../execution/errors';
import type { AgentInput } from '../providers/content';
import type { ToolCall } from '../providers/llm';
import { parseEventStream } from '../ui/parseEventStream';

/** Where and how to reach a deployed agent; the turn goes to `<url>/chat`. */
export interface SessionClientOptions {
  url: string;
  /** Bearer token, or a function returning it (called per turn). */
  auth?: string | (() => string | Promise<string>);
  /** Extra request headers (`Authorization` from `auth` wins). */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

/** One turn to post; `label` is the subject of error messages. */
export interface SessionTurn {
  sessionId: string;
  input: AgentInput;
  signal?: AbortSignal;
  label: string;
}

/** The tool call a paused remote run waits on. */
export type PendingApproval = AgentEventOf<'approval.requested'>;

/** What a finished remote turn amounts to. */
export interface SessionTurnSummary {
  sessionId: string;
  text: string;
  finishReason: AgentEventOf<'run.done'>['finishReason'];
  /** Tool calls and model steps of the remote run itself (not its sub-agents'). */
  toolCalls: ToolCall[];
  steps: number;
  usage?: AgentEventUsage;
  /** Set when the run paused (`finishReason: 'awaiting-approval'`). */
  approval?: PendingApproval;
  /** The remote run's error message, when it ended in an error. */
  error?: string;
  /** LOU-Y7.3: the remote run's validated `output` object (`run.done`'s `object`), when its agent has an `output` schema. */
  object?: unknown;
}

/** LOU-Y7.3: a decision on a remote run's pending approval; for an `ask_question` pause, `note` is the answer. */
export interface RemoteApprovalDecision {
  sessionId: string;
  approvalId: string;
  approved: boolean;
  note?: string;
  signal?: AbortSignal;
  label: string;
}

/** The server's `{ error }` message, or the start of the body. */
async function errorDetail(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  const parsed = await Promise.resolve().then(() => (JSON.parse(body) as { error?: unknown } | null)?.error).catch(() => undefined); // not JSON: raw text
  return (typeof parsed === 'string' ? parsed : body).slice(0, 300);
}

/** Folds a stream into a summary; `undefined` when it ended without `run.done`. */
async function fold(sessionId: string, events: AsyncIterable<AgentEvent>): Promise<SessionTurnSummary | undefined> {
  const toolCalls: ToolCall[] = [];
  let steps = 0;
  let error: string | undefined;
  let approval: PendingApproval | undefined;
  for await (const event of events) {
    if (event.type === 'error') error = event.error.message;
    if (event.type === 'approval.requested') approval = event;
    if (event.subagent) continue;
    if (event.type === 'step.done') steps++;
    if (event.type === 'tool.start' || event.type === 'tool.resume') toolCalls.push({ id: event.toolCallId, type: 'function', function: { name: event.toolName, arguments: JSON.stringify(event.args) } });
    if (event.type === 'run.done') return { sessionId, text: event.text, finishReason: event.finishReason, toolCalls, steps, usage: event.usage, approval, error, object: event.object };
  }
  return undefined;
}

type Fail = (what: string, cause?: unknown, code?: string) => SDKError;
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** One POST to the session API: the path under `<url>`, the JSON body, and what the stream is folded for. */
interface SessionRequest {
  path: string;
  body: Record<string, unknown>;
  sessionId: string;
  signal?: AbortSignal;
  label: string;
}

/** POSTs the request; throws for a network error, an abort or a non-2xx answer (401 is `LOUSHO_REMOTE_UNAUTHORIZED`). */
async function post(options: SessionClientOptions, request: SessionRequest, token: string | undefined, fail: Fail): Promise<Response> {
  const url = `${options.url.replace(/\/+$/, '')}${request.path}`;
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...options.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, { method: 'POST', headers, body: JSON.stringify(request.body), signal: request.signal });
  } catch (error) {
    throw fail(request.signal?.aborted ? 'was aborted.' : `could not be reached at ${url}: ${reasonOf(error)}`, error);
  }
  if (response.ok) return response;
  const unauthorized = response.status === 401;
  const where = `at ${url} ${unauthorized ? 'rejected the bearer token (401); check `auth`' : `answered ${response.status}`}`;
  const detail = await errorDetail(response);
  throw fail(detail ? `${where}: ${detail}` : where, undefined, unauthorized ? 'LOUSHO_REMOTE_UNAUTHORIZED' : undefined);
}

/** Posts `request` and folds the streamed answer; the coded errors of {@link runRemoteTurn}, token scrubbed. */
async function exchange(options: SessionClientOptions, request: SessionRequest): Promise<SessionTurnSummary> {
  const token = typeof options.auth === 'function' ? await options.auth() : options.auth;
  const fail: Fail = (what, cause, code = 'LOUSHO_REMOTE_REQUEST_FAILED') => {
    const message = `${request.label} ${what}`;
    return new SDKError(token ? message.split(token).join('[redacted]') : message, code, { cause });
  };
  const response = await post(options, request, token, fail);
  const summary = await fold(request.sessionId, parseEventStream(response)).catch((error: unknown) => {
    throw fail(`${request.signal?.aborted ? 'was aborted' : 'stream failed'}: ${reasonOf(error)}`, error);
  });
  if (!summary) throw fail('closed the stream without a final event, i.e. without a run.done (truncated, or the url is not a lousho /chat API)');
  return summary;
}

/**
 * Posts one turn and reads the stream to the end. Throws `SDKError` `LOUSHO_REMOTE_UNAUTHORIZED` (401) or `LOUSHO_REMOTE_REQUEST_FAILED`
 * (unreachable, other non-2xx, aborted, broken or truncated stream), token scrubbed. A remote run that errors or pauses is reported in the summary.
 */
export function runRemoteTurn(options: SessionClientOptions, turn: SessionTurn): Promise<SessionTurnSummary> {
  const { sessionId, input, signal, label } = turn;
  return exchange(options, { path: '/chat', body: { sessionId, input }, sessionId, signal, label });
}

/**
 * LOU-Y7.3: decides a remote run's pending approval (`POST <url>/chat/:sessionId/approvals/:id`) and reads the continuation
 * to its end, with the summary and coded errors of {@link runRemoteTurn} (an approval no longer pending is the remote's 404).
 */
export function resolveRemoteApproval(options: SessionClientOptions, decision: RemoteApprovalDecision): Promise<SessionTurnSummary> {
  const { sessionId, approvalId, approved, note, signal, label } = decision;
  const path = `/chat/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`;
  return exchange(options, { path, body: { approved, ...(note !== undefined && { note }) }, sessionId, signal, label });
}
