/** LOU-D53: the one client for a deployed agent's session API (`POST <url>/chat`, SSE answer, bearer auth). Fetch only, Worker-safe. */
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
    if (event.type === 'tool.start') toolCalls.push({ id: event.toolCallId, type: 'function', function: { name: event.toolName, arguments: JSON.stringify(event.args) } });
    if (event.type === 'run.done') return { sessionId, text: event.text, finishReason: event.finishReason, toolCalls, steps, usage: event.usage, approval, error };
  }
  return undefined;
}

type Fail = (what: string, cause?: unknown, code?: string) => SDKError;
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** POSTs the turn; throws for a network error, an abort or a non-2xx answer (401 is `LOUSHY_REMOTE_UNAUTHORIZED`). */
async function post(options: SessionClientOptions, turn: SessionTurn, token: string | undefined, fail: Fail): Promise<Response> {
  const url = `${options.url.replace(/\/+$/, '')}/chat`;
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...options.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  let response: Response;
  try {
    const body = JSON.stringify({ sessionId: turn.sessionId, input: turn.input });
    response = await (options.fetch ?? fetch)(url, { method: 'POST', headers, body, signal: turn.signal });
  } catch (error) {
    throw fail(turn.signal?.aborted ? 'was aborted.' : `could not be reached at ${url}: ${reasonOf(error)}`, error);
  }
  if (response.ok) return response;
  const unauthorized = response.status === 401;
  const where = `at ${url} ${unauthorized ? 'rejected the bearer token (401); check `auth`' : `answered ${response.status}`}`;
  const detail = await errorDetail(response);
  throw fail(detail ? `${where}: ${detail}` : where, undefined, unauthorized ? 'LOUSHY_REMOTE_UNAUTHORIZED' : undefined);
}

/**
 * Posts one turn and reads the stream to the end. Throws `SDKError` `LOUSHY_REMOTE_UNAUTHORIZED` (401) or `LOUSHY_REMOTE_REQUEST_FAILED`
 * (unreachable, other non-2xx, aborted, broken or truncated stream), token scrubbed. A remote run that errors or pauses is reported in the summary.
 */
export async function runRemoteTurn(options: SessionClientOptions, turn: SessionTurn): Promise<SessionTurnSummary> {
  const token = typeof options.auth === 'function' ? await options.auth() : options.auth;
  const fail: Fail = (what, cause, code = 'LOUSHY_REMOTE_REQUEST_FAILED') => {
    const message = `${turn.label} ${what}`;
    return new SDKError(token ? message.split(token).join('[redacted]') : message, code, { cause });
  };
  const response = await post(options, turn, token, fail);
  const summary = await fold(turn.sessionId, parseEventStream(response)).catch((error: unknown) => {
    throw fail(`${turn.signal?.aborted ? 'was aborted' : 'stream failed'}: ${reasonOf(error)}`, error);
  });
  if (!summary) throw fail('closed the stream without a final event, i.e. without a run.done (truncated, or the url is not a loushy /chat API)');
  return summary;
}
