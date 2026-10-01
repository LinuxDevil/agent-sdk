/**
 * LOU-D15: `useLoushyAgent()`, a React hook over an agent's typed event
 * stream. The state logic lives in the framework-neutral reducer.ts; this
 * file only runs the stream (in process or over HTTP) and dispatches.
 */

import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { SimpleAgent } from '../createAgent';
import type { AgentInput } from '../providers/content';
import type { AgentEvent, AgentEventError } from '../execution/agentEvents';
import type { AgentSession } from '../session/AgentSession';
import { parseEventStream } from './parseEventStream';
import {
  initialAgentUIState,
  reduceAgentEvents,
  type AgentUIAction,
  type AgentUIState,
  type ApprovalOutcome,
} from './reducer';

/** Runs a `createAgent()` agent in this process; with `sessionId`, in one `agent.session()` that keeps the conversation. */
export interface LocalAgentSource {
  agent: SimpleAgent;
  sessionId?: string;
}

/** An HTTP endpoint that takes `POST { input }` and answers with the run's events (SSE or NDJSON). */
export interface RemoteAgentSource {
  url: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export type LoushyAgentSource = LocalAgentSource | RemoteAgentSource;

export interface UseLoushyAgentOptions {
  /**
   * Remote mode: `approve()`/`reject()` POST `{ approved, note }` to
   * `${approvalsUrl}/${approvalId}` and read an {@link ApprovalOutcome} JSON
   * response. Without it they do nothing: resolve `pendingApproval` yourself.
   */
  approvalsUrl?: string;
}

export interface UseLoushyAgentResult extends AgentUIState {
  /** Starts a turn (aborting one still running). */
  send(input: AgentInput): Promise<void>;
  /** Aborts the run in flight; it ends with `finishReason: 'aborted'`. */
  stop(): void;
  approve(note?: string): Promise<void>;
  reject(note?: string): Promise<void>;
}

type Emit = (action: AgentEvent | AgentUIAction) => void;

function toEventError(error: unknown): AgentEventError {
  return error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) };
}

type CachedSession = { agent: SimpleAgent; id: string; session: AgentSession };

/** The agent, or its session `sessionId` (created once per agent and id, so it keeps the conversation). */
function streamTarget({ agent, sessionId: id }: LocalAgentSource, cache: { current: CachedSession | null }) {
  if (id === undefined) return agent;
  if (cache.current?.agent !== agent || cache.current.id !== id) cache.current = { agent, id, session: agent.session({ id }) };
  return cache.current.session;
}

async function post(source: RemoteAgentSource, url: string, body: unknown, signal: AbortSignal): Promise<Response> {
  const headers = { 'Content-Type': 'application/json', ...source.headers };
  const response = await (source.fetch ?? fetch)(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!response.ok) throw new Error(`POST ${url} failed with ${response.status}`);
  return response;
}

/**
 * Chat UI state for an agent: `messages` stream in as the run's events
 * arrive, `status` drives the composer, and a paused tool call shows up as
 * `pendingApproval` until `approve()` or `reject()`. Unmounting aborts the
 * run in flight. See docs/react.md.
 *
 * @example
 * ```ts
 * const { messages, status, send } = useLoushyAgent({ url: '/api/agent' });
 * ```
 */
export function useLoushyAgent(source: LoushyAgentSource, options: UseLoushyAgentOptions = {}): UseLoushyAgentResult {
  const [state, dispatch] = useReducer(reduceAgentEvents, initialAgentUIState);
  const latest = useRef({ source, options, state });
  latest.current = { source, options, state };
  const controller = useRef<AbortController | null>(null);
  const session = useRef<CachedSession | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  /** Runs `task` as the current run; once another run replaces it, its events are dropped. */
  const run = useCallback(async (task: (emit: Emit, signal: AbortSignal) => Promise<void>) => {
    controller.current?.abort();
    const mine = (controller.current = new AbortController());
    const emit: Emit = (action) => {
      if (controller.current === mine) dispatch(action);
    };
    try {
      await task(emit, mine.signal);
    } catch (error) {
      if (!mine.signal.aborted) emit({ type: 'ui.error', error: toEventError(error) });
    } finally {
      if (mine.signal.aborted) emit({ type: 'ui.stopped' });
    }
  }, []);

  const send = useCallback(
    (input: AgentInput) =>
      run(async (emit, signal) => {
        emit({ type: 'ui.send', input });
        const { source } = latest.current;
        let events: AsyncIterable<AgentEvent>;
        if ('agent' in source) {
          events = streamTarget(source, session).stream(input, { signal });
        } else {
          events = parseEventStream(await post(source, source.url, { input }, signal));
        }
        for await (const event of events) emit(event);
      }),
    [run]
  );

  const decide = useCallback(
    (approved: boolean, note?: string) => {
      const { source, options, state } = latest.current;
      const pending = state.pendingApproval;
      if (!pending || !('agent' in source || options.approvalsUrl)) return Promise.resolve();
      return run(async (emit, signal) => {
        emit({ type: 'ui.decide', approved });
        const decision = { id: pending.id, approved, note };
        let outcome: ApprovalOutcome;
        if ('agent' in source) {
          const result = await source.agent.approvals.resolve(decision, { signal });
          const approval = (await source.agent.approvals.list()).find((a) => a.id === result.approvalId);
          outcome = { text: result.text, finishReason: result.finishReason, usage: result.usage, approval };
        } else {
          const url = `${options.approvalsUrl}/${encodeURIComponent(pending.id)}`;
          outcome = (await (await post(source, url, { approved, note }, signal)).json()) as ApprovalOutcome;
        }
        emit({ type: 'ui.resumed', outcome });
      });
    },
    [run]
  );

  const stop = useCallback(() => controller.current?.abort(), []);
  const approve = useCallback((note?: string) => decide(true, note), [decide]);
  const reject = useCallback((note?: string) => decide(false, note), [decide]);

  return { ...state, send, stop, approve, reject };
}
