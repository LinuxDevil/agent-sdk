/**
 * LOU-Y7: `remoteAgent()` - a deployed agent (the `/chat` session API of the
 * node server or the Cloudflare Worker, bearer auth) used as a sub-agent of a
 * lead agent. Built on the shared session client (LOU-D53); fetch only, so it
 * runs in Workers too.
 */

import { SDKError } from '../execution/errors';
import { runRemoteTurn, type SessionTurnSummary } from '../server/sessionClient';
import { newId } from '../utils/id';
import type { RemoteAgentOptions, RemoteSubagent } from './types';

/** The agents {@link remoteAgent} made, so `withSubagents()` can tell them from `createAgent()` agents. */
const remoteSubagents = new WeakSet<object>();

/** Whether `value` was made by {@link remoteAgent}. */
export function isRemoteSubagent(value: unknown): value is RemoteSubagent {
  return typeof value === 'object' && value !== null && remoteSubagents.has(value);
}

/** The text of a finished remote run (with a footer), or the error that says why there is none. */
function outcome(label: string, name: string, summary: SessionTurnSummary): string {
  const { finishReason, text, sessionId, approval } = summary;
  if (finishReason === 'awaiting-approval') {
    throw new SDKError(
      `Remote agent '${name}' is awaiting approval${approval ? ` '${approval.approvalId}'` : ''} in its session '${sessionId}'. ` +
        'Approvals of remote sub-agents are not proxied: decide it on the remote agent (POST /chat/<session>/approvals/<id>), or give the remote agent no tools that need approval.',
      'LOUSHY_SESSION_AWAITING_APPROVAL'
    );
  }
  if (finishReason === 'error') {
    throw new SDKError(`${label} failed: the remote run ended in an error: ${summary.error ?? 'unknown error'}`, 'LOUSHY_REMOTE_REQUEST_FAILED');
  }
  if (finishReason !== 'stop' && finishReason !== 'length') {
    throw new SDKError(`${label} ended with finish reason '${finishReason}' without a final answer.`, 'LOUSHY_REMOTE_REQUEST_FAILED');
  }
  const footer = `[remote sub-agent '${name}': session '${sessionId}', finish reason '${finishReason}']`;
  return text ? `${text}\n\n${footer}` : footer;
}

/**
 * Uses an agent deployed with `loushy deploy` (node server, Docker or
 * Cloudflare Worker) as a sub-agent: put it in `createAgent({ subagents })`
 * next to local ones. Each delegated task opens a fresh session on the remote
 * agent over `POST <url>/chat`, sends the task prompt, reads the streamed run
 * to its end and returns the remote agent's final text. The lead run's abort
 * signal aborts the request. Failures reach the lead as the usual structured
 * tool error with a `LOUSHY_REMOTE_REQUEST_FAILED` (or, for a 401,
 * `LOUSHY_REMOTE_UNAUTHORIZED`) code; a remote run that pauses for approval
 * fails with `LOUSHY_SESSION_AWAITING_APPROVAL` (approvals are not proxied).
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
      const label = `Remote agent '${name}' (session '${sessionId}')`;
      return outcome(label, name, await runRemoteTurn(options, { sessionId, input: prompt, signal, label }));
    },
  };
  remoteSubagents.add(agent);
  return agent;
}
