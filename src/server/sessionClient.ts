/**
 * LOU-D53: the one client for a deployed agent's session API
 * (`POST <url>/chat { sessionId, input }` answered with an SSE stream, bearer
 * auth). `remoteAgent()` (sub-agents) and `remoteTarget()` (evals) are built on
 * it. Fetch only, so it runs in Workers too.
 */
import type { AgentEvent, AgentEventOf, AgentEventUsage } from '../execution/agentEvents';
import { SDKError } from '../execution/errors';
import type { AgentInput } from '../providers/content';
import type { ToolCall } from '../providers/llm';
import { parseEventStream } from '../ui/parseEventStream';

const MAX_ERROR_BODY = 300;

/** Where and how to reach a deployed agent. */
export interface SessionClientOptions {
  /** Base URL of the deployment; the turn goes to `<url>/chat`. */
  url: string;
  /** Bearer token, or a function returning it (called per turn). */
  auth?: string | (() => string | Promise<string>);
  /** Extra request headers (`Authorization` from `auth` wins). */
  headers?: Record<string, string>;
  /** `fetch` to use; defaults to the global one. */
  fetch?: typeof fetch;
}

/** One turn to post. */
export interface SessionTurn {
  sessionId: string;
  input: AgentInput;
  signal?: AbortSignal;
  /** Subject of error messages, e.g. `Remote agent 'researcher' (session 'task_1')`. */
  label: string;
}

/** A tool call the remote run paused on. */
export interface PendingApproval {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

/** What a finished remote turn amounts to. */
export interface SessionTurnSummary {
  sessionId: string;
  text: string;
  finishReason: AgentEventOf<'run.done'>['finishReason'];
  /** Tool calls of the remote run itself (not its sub-agents'). */
  toolCalls: ToolCall[];
  /** Model steps of the remote run itself. */
  steps: number;
  /** Usage of the whole run, when the stream carried it. */
  usage?: AgentEventUsage;
  /** Set when the run paused (`finishReason: 'awaiting-approval'`). */
  approval?: PendingApproval;
  /** The remote run's error message, when it ended in an error. */
  error?: string;
}

/** `text` with every occurrence of the bearer `token` replaced, so a token never reaches an error. */
const scrub = (text: string, token: string | undefined): string => (token ? text.split(token).join('[redacted]') : text);

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The server's `{ error }` message, or the start of the body. */
async function errorDetail(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(body) as { error?: unknown } | null;
    if (typeof parsed?.error === 'string') return parsed.error.slice(0, MAX_ERROR_BODY);
  } catch {
    // not JSON: use the raw text
  }
  return body.slice(0, MAX_ERROR_BODY);
}

/** POSTs the turn; throws a coded error for a network error, a 401 or another non-2xx answer. */
async function post(options: SessionClientOptions, turn: SessionTurn, token: string | undefined, url: string): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    ...options.headers,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const fail = (what: string, code: string, cause?: unknown) => new SDKError(scrub(`${turn.label} ${what}`, token), code, { cause });
  let response: Response;
  try {
    const body = JSON.stringify({ sessionId: turn.sessionId, input: turn.input });
    response = await (options.fetch ?? fetch)(url, { method: 'POST', headers, body, signal: turn.signal });
  } catch (error) {
    throw fail(turn.signal?.aborted ? 'was aborted.' : `could not be reached at ${url}: ${reasonOf(error)}`, 'LOUSHY_REMOTE_REQUEST_FAILED', error);
  }
  if (response.ok) return response;
  const detail = await errorDetail(response);
  const suffix = detail ? `: ${detail}` : '';
  if (response.status === 401) throw fail(`at ${url} rejected the bearer token (401); check \`auth\`${suffix}`, 'LOUSHY_REMOTE_UNAUTHORIZED');
  throw fail(`at ${url} answered ${response.status}${suffix}`, 'LOUSHY_REMOTE_REQUEST_FAILED');
}

/** Folds a stream into a summary; `undefined` when it ended without `run.done`. */
async function fold(sessionId: string, events: AsyncIterable<AgentEvent>): Promise<SessionTurnSummary | undefined> {
  const toolCalls: ToolCall[] = [];
  let steps = 0;
  let error: string | undefined;
  let approval: PendingApproval | undefined;
  for await (const event of events) {
    if (event.type === 'error') error = event.error.message;
    if (event.type === 'approval.requested') {
      approval = { approvalId: event.approvalId, toolCallId: event.toolCallId, toolName: event.toolName, args: event.args };
    }
    if (event.subagent) continue;
    if (event.type === 'step.done') steps++;
    if (event.type === 'tool.start') {
      toolCalls.push({ id: event.toolCallId, type: 'function', function: { name: event.toolName, arguments: JSON.stringify(event.args) } });
    }
    if (event.type === 'run.done') {
      return { sessionId, text: event.text, finishReason: event.finishReason, toolCalls, steps, usage: event.usage, approval, error };
    }
  }
  return undefined;
}

/**
 * Posts one turn to a deployed agent and reads its stream to the end. Throws an
 * `SDKError` with `LOUSHY_REMOTE_UNAUTHORIZED` (401) or `LOUSHY_REMOTE_REQUEST_FAILED`
 * (unreachable, other non-2xx, aborted, broken or truncated stream); the bearer
 * token is scrubbed from every message. A remote run that ends in an error or
 * pauses for approval is not a failure here: the summary says so.
 */
export async function runRemoteTurn(options: SessionClientOptions, turn: SessionTurn): Promise<SessionTurnSummary> {
  const token = typeof options.auth === 'function' ? await options.auth() : options.auth;
  const url = `${options.url.replace(/\/+$/, '')}/chat`;
  const response = await post(options, turn, token, url);
  const broken = (what: string, cause?: unknown) => new SDKError(scrub(`${turn.label} ${what}`, token), 'LOUSHY_REMOTE_REQUEST_FAILED', { cause });
  let summary: SessionTurnSummary | undefined;
  try {
    summary = await fold(turn.sessionId, parseEventStream(response));
  } catch (error) {
    throw broken(`${turn.signal?.aborted ? 'was aborted' : 'stream failed'}: ${reasonOf(error)}`, error);
  }
  if (!summary) throw broken('closed the stream without a final event, i.e. without a run.done (truncated, or the url is not a loushy /chat API)');
  return summary;
}
