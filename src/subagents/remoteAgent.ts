/**
 * LOU-Y7: `remoteAgent()` - a deployed agent (the `/chat` session API of the
 * node server or the Cloudflare Worker, bearer auth) used as a sub-agent of a
 * lead agent. Fetch only, so it runs in Workers too.
 */

import { SDKError } from '../execution/errors';
import type { AgentEvent } from '../execution/agentEvents';
import { parseEventStream } from '../react/parseEventStream';
import { newId } from '../utils/id';
import type { RemoteAgentOptions, RemoteSubagent } from './types';

const REMOTE_FAILED = 'LOUSHY_REMOTE_AGENT_FAILED';
const MAX_ERROR_BODY = 300;

/** The agents {@link remoteAgent} made, so `withSubagents()` can tell them from `createAgent()` agents. */
const remoteSubagents = new WeakSet<object>();

/** Whether `value` was made by {@link remoteAgent}. */
export function isRemoteSubagent(value: unknown): value is RemoteSubagent {
  return typeof value === 'object' && value !== null && remoteSubagents.has(value);
}

/** `text` with every occurrence of the bearer `token` replaced, so a token never reaches an error. */
function scrub(text: string, token: string | undefined): string {
  return token ? text.split(token).join('[redacted]') : text;
}

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

function failed(name: string, sessionId: string, what: string): SDKError {
  return new SDKError(`Remote agent '${name}' (session '${sessionId}') ${what}`, REMOTE_FAILED);
}

/** The final text of the remote run's events (with a footer), or the error that says why there is none. */
async function finalText(name: string, sessionId: string, events: AsyncIterable<AgentEvent>): Promise<string> {
  let errorMessage: string | undefined;
  let approvalId: string | undefined;
  for await (const event of events) {
    if (event.type === 'error') errorMessage = event.error.message;
    if (event.type === 'approval.requested') approvalId = event.approvalId;
    if (event.type !== 'run.done') continue;
    const { finishReason, text } = event;
    if (finishReason === 'awaiting-approval') {
      throw new SDKError(
        `Remote agent '${name}' is awaiting approval${approvalId ? ` '${approvalId}'` : ''} in its session '${sessionId}'. ` +
          'Approvals of remote sub-agents are not proxied: decide it on the remote agent (POST /chat/<session>/approvals/<id>), or give the remote agent no tools that need approval.',
        'LOUSHY_SESSION_AWAITING_APPROVAL'
      );
    }
    if (finishReason === 'error') throw failed(name, sessionId, `failed: ${errorMessage ?? 'unknown error'}`);
    if (finishReason !== 'stop' && finishReason !== 'length') {
      throw failed(name, sessionId, `ended with finish reason '${finishReason}' without a final answer.`);
    }
    const footer = `[remote sub-agent '${name}': session '${sessionId}', finish reason '${finishReason}']`;
    return text ? `${text}\n\n${footer}` : footer;
  }
  throw failed(name, sessionId, 'closed the stream without a final event; is the url a loushy /chat API?');
}

/** POSTs the task to `<url>/chat`; throws for a network error or a non-2xx answer. */
async function post(options: RemoteAgentOptions, name: string, sessionId: string, input: string, signal?: AbortSignal): Promise<Response> {
  const token = typeof options.auth === 'function' ? await options.auth() : options.auth;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    ...options.headers,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const url = `${options.url.replace(/\/+$/, '')}/chat`;
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, { method: 'POST', headers, body: JSON.stringify({ sessionId, input }), signal });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw failed(name, sessionId, signal?.aborted ? 'was aborted.' : `could not be reached at ${url}: ${scrub(reason, token)}`);
  }
  if (response.ok) return response;
  const detail = scrub(await errorDetail(response), token);
  const why = response.status === 401 ? "rejected the bearer token (401); check the remote agent's `auth`" : `answered ${response.status}`;
  throw failed(name, sessionId, `at ${url} ${why}${detail ? `: ${detail}` : ''}`);
}

/**
 * Uses an agent deployed with `loushy deploy` (node server, Docker or
 * Cloudflare Worker) as a sub-agent: put it in `createAgent({ subagents })`
 * next to local ones. Each delegated task opens a fresh session on the remote
 * agent over `POST <url>/chat`, sends the task prompt, reads the streamed run
 * to its end and returns the remote agent's final text. The lead run's abort
 * signal aborts the request. Failures reach the lead as the usual structured
 * tool error with a `LOUSHY_REMOTE_AGENT_FAILED` code; a remote run that
 * pauses for approval fails with `LOUSHY_SESSION_AWAITING_APPROVAL` (approvals
 * are not proxied).
 *
 * @example
 * ```ts
 * const lead = createAgent({
 *   model: 'openai/gpt-4o-mini',
 *   subagents: {
 *     researcher: remoteAgent({
 *       url: 'https://researcher.example.workers.dev',
 *       auth: process.env.RESEARCHER_TOKEN,
 *       description: 'Researches a topic on the web',
 *     }),
 *   },
 * });
 * ```
 */
export function remoteAgent(options: RemoteAgentOptions): RemoteSubagent {
  if (!options.url) {
    throw new SDKError("remoteAgent: 'url' is required, e.g. remoteAgent({ url: 'https://my-agent.example.com' }).", 'LOUSHY_CONFIG_INVALID');
  }
  const agent: RemoteSubagent = {
    name: options.name,
    description: options.description ?? `Remote agent at ${options.url}`,
    async run(prompt, { name = options.name ?? 'remote-agent', signal } = {}) {
      const sessionId = newId('task');
      const response = await post(options, name, sessionId, prompt, signal);
      try {
        return await finalText(name, sessionId, parseEventStream(response));
      } catch (error) {
        if (error instanceof SDKError) throw error;
        throw failed(name, sessionId, `${signal?.aborted ? 'was aborted' : 'stream failed'}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
  remoteSubagents.add(agent);
  return agent;
}
