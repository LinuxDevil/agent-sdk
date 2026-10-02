/** LOU-Y7: `remoteAgent()`, a deployed agent used as a sub-agent. Built on the shared session client (LOU-D53); Worker-safe. */

import { SDKError } from '../execution/errors';
import { SubagentApprovalPause } from '../execution/subagentRuntime';
import { resolveRemoteApproval, runRemoteTurn, type PendingApproval, type SessionTurnSummary } from '../server/sessionClient';
import { newId } from '../utils/id';
import type { RemoteAgentOptions, RemoteRunOptions, RemoteSubagent } from './types';

/** The agents {@link remoteAgent} made, so `withSubagents()` can tell them from `createAgent()` agents. */
const remoteSubagents = new WeakSet<object>();

/** Whether `value` was made by {@link remoteAgent}. */
export function isRemoteSubagent(value: unknown): value is RemoteSubagent {
  return typeof value === 'object' && value !== null && remoteSubagents.has(value);
}

/**
 * LOU-Y7.3: a paused remote run as a sub-agent pause, which the lead run pauses on. Its snapshot holds no transcript:
 * `sessionId` is the remote session and the pending call's `id` the remote approval id, all a resume needs (no token).
 */
function remotePause(name: string, sessionId: string, approval: PendingApproval): SubagentApprovalPause {
  const { approvalId: id, toolCallId, toolName, args } = approval;
  const pendingToolCall = { id, toolCallId, toolName, args, createdAt: new Date().toISOString() };
  return new SubagentApprovalPause(name, { agent: { name }, currentMessages: [], pendingToolCall, steps: 0, sessionId });
}

/** A remote pause the lead cannot pause on (it has no approval store). */
function awaitingApproval(name: string, { sessionId, approval }: SessionTurnSummary, taskId?: string): SDKError {
  const then = taskId ? ` and then continue task '${taskId}'` : '';
  return new SDKError(
    `Remote agent '${name}' is awaiting approval${approval ? ` '${approval.approvalId}'` : ''} in its session '${sessionId}'. ` +
      `The lead run has no approval store to pause on: decide it on the remote agent (POST /chat/<session>/approvals/<id>)${then}, or give the remote agent no tools that need approval.`,
    'LOUSHO_SESSION_AWAITING_APPROVAL'
  );
}

/** The answer of a finished remote run (its `output` object as JSON, else its text) with a footer, or the error that says why there is none. */
function outcome(label: string, name: string, summary: SessionTurnSummary, { taskId, pausable }: RemoteRunOptions): string {
  const { finishReason, text, sessionId, approval, object } = summary;
  if (finishReason === 'awaiting-approval') {
    throw pausable && approval ? remotePause(name, sessionId, approval) : awaitingApproval(name, summary, taskId);
  }
  if (finishReason === 'error') {
    throw new SDKError(`${label} failed: the remote run ended in an error: ${summary.error ?? 'unknown error'}`, 'LOUSHO_REMOTE_REQUEST_FAILED');
  }
  if (finishReason !== 'stop' && finishReason !== 'length') {
    throw new SDKError(`${label} ended with finish reason '${finishReason}' without a final answer.`, 'LOUSHO_REMOTE_REQUEST_FAILED');
  }
  const footer = `[remote sub-agent '${name}': session '${sessionId}', finish reason '${finishReason}'${taskId ? `, taskId '${taskId}'` : ''}]`;
  const body = object === undefined ? text : JSON.stringify(object);
  return body ? `${body}\n\n${footer}` : footer;
}

/**
 * Uses an agent deployed with `lousho deploy` (node server, Docker or
 * Cloudflare Worker) as a sub-agent: put it in `createAgent({ subagents })`
 * next to local ones. Each delegated task opens a fresh session on the remote
 * agent over `POST <url>/chat` (a `task` call that resumes a task reuses its
 * session, LOU-Y6), sends the task prompt, reads the streamed run
 * to its end and returns the remote agent's final text (its `output` object as
 * JSON when it has an `output` schema). The lead run's abort
 * signal aborts the request. Failures reach the lead as the usual structured
 * tool error with a `LOUSHO_REMOTE_REQUEST_FAILED` (or, for a 401,
 * `LOUSHO_REMOTE_UNAUTHORIZED`) code. A remote run that pauses for approval
 * pauses the lead run (LOU-Y7.3): deciding it on the lead decides it on the
 * remote agent, and the continuation's answer is the task result.
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
    throw new SDKError("remoteAgent: 'url' is required, e.g. remoteAgent({ url: 'https://my-agent.example.com' }).", 'LOUSHO_CONFIG_INVALID');
  }
  const agent: RemoteSubagent = {
    name: options.name,
    description: options.description ?? `Remote agent at ${options.url}`,
    async run(prompt, run = {}) {
      const { name = options.name ?? 'remote-agent', signal, sessionId = newId('task'), decision } = run;
      const label = `Remote agent '${name}' (session '${sessionId}')`;
      const summary = decision
        ? await resolveRemoteApproval(options, { ...decision, sessionId, signal, label })
        : await runRemoteTurn(options, { sessionId, input: prompt, signal, label });
      if (summary.usage) run.onUsage?.(summary.usage);
      return outcome(label, name, summary, run);
    },
  };
  remoteSubagents.add(agent);
  return agent;
}
