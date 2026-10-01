/**
 * LOU-D15, LOU-P2: the framework-neutral run logic behind the UI bindings
 * (React, Vue, later Svelte): starts turns (in process or over HTTP), feeds
 * the events to a dispatch function and handles approvals and abort. A
 * binding only holds the state and hands the runner its latest inputs.
 */

import type { SimpleAgent } from '../createAgent';
import type { AgentInput } from '../providers/content';
import type { AgentEvent, AgentEventError } from '../execution/agentEvents';
import type { AgentSession } from '../session/AgentSession';
import { parseEventStream } from './parseEventStream';
import type { AgentUIAction, AgentUIState, ApprovalOutcome } from './reducer';

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

export interface LoushyAgentOptions {
  /**
   * Remote mode: `approve()`/`reject()` POST `{ approved, note }` to
   * `${approvalsUrl}/${approvalId}` and show the continuation live from the
   * SSE response (an older server's {@link ApprovalOutcome} JSON still works). Without it they do nothing: resolve `pendingApproval` yourself.
   */
  approvalsUrl?: string;
}

/** The actions every binding exposes next to the state. */
export interface AgentCommands {
  /** Starts a turn (aborting one still running). */
  send(input: AgentInput): Promise<void>;
  /** Aborts the run in flight; it ends with `finishReason: 'aborted'`. */
  stop(): void;
  approve(note?: string): Promise<void>;
  reject(note?: string): Promise<void>;
  /** LOU-X9: answers the question in `pendingApproval` (`kind: 'question'`); same as `approve(text)`. */
  answer(text: string): Promise<void>;
}

/** What a binding hands the runner: its latest inputs and its way to update the state. */
export interface AgentRunnerHost {
  source(): LoushyAgentSource;
  options(): LoushyAgentOptions;
  state(): AgentUIState;
  dispatch(action: AgentEvent | AgentUIAction): void;
}

type Emit = (action: AgentEvent | AgentUIAction) => void;
type CachedSession = { agent: SimpleAgent; id: string; session: AgentSession };

function toEventError(error: unknown): AgentEventError {
  return error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) };
}

async function post(source: RemoteAgentSource, url: string, body: unknown, signal: AbortSignal): Promise<Response> {
  const headers = { 'Content-Type': 'application/json', ...source.headers };
  const response = await (source.fetch ?? fetch)(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!response.ok) throw new Error(`POST ${url} failed with ${response.status}`);
  return response;
}

/** LOU-D32.2: the session API streams the continuation as SSE; an older server answers with an ApprovalOutcome JSON. */
async function relayContinuation(response: Response, emit: Emit): Promise<void> {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    return emit({ type: 'ui.resumed', outcome: (await response.json()) as ApprovalOutcome });
  }
  for await (const event of parseEventStream(response)) emit(event);
}

/**
 * The runner of one chat: `send`, `stop`, `approve`, `reject`, `answer`, plus
 * `reset` (aborts, forgets the in-process session and clears the state).
 * Call `stop()` when the owner goes away (unmount, scope disposal).
 */
export function createAgentRunner(host: AgentRunnerHost): AgentCommands & { reset(): void } {
  let controller: AbortController | null = null;
  let cached: CachedSession | null = null;

  /** The agent, or its session `sessionId` (created once per agent and id, so it keeps the conversation). */
  function streamTarget({ agent, sessionId: id }: LocalAgentSource) {
    if (id === undefined) return agent;
    if (cached?.agent !== agent || cached.id !== id) cached = { agent, id, session: agent.session({ id }) };
    return cached.session;
  }

  /** Runs `task` as the current run; once another run replaces it, its events are dropped. */
  async function run(task: (emit: Emit, signal: AbortSignal) => Promise<void>): Promise<void> {
    controller?.abort();
    const mine = (controller = new AbortController());
    const emit: Emit = (action) => {
      if (controller === mine) host.dispatch(action);
    };
    try {
      await task(emit, mine.signal);
    } catch (error) {
      if (!mine.signal.aborted) emit({ type: 'ui.error', error: toEventError(error) });
    } finally {
      if (mine.signal.aborted) emit({ type: 'ui.stopped' });
    }
  }

  const send = (input: AgentInput) =>
    run(async (emit, signal) => {
      emit({ type: 'ui.send', input });
      const source = host.source();
      let events: AsyncIterable<AgentEvent>;
      if ('agent' in source) {
        events = streamTarget(source).stream(input, { signal });
      } else {
        events = parseEventStream(await post(source, source.url, { input }, signal));
      }
      for await (const event of events) emit(event);
    });

  const decide = (approved: boolean, note?: string) => {
    const source = host.source();
    const options = host.options();
    const pending = host.state().pendingApproval;
    if (!pending || !('agent' in source || options.approvalsUrl)) return Promise.resolve();
    return run(async (emit, signal) => {
      emit({ type: 'ui.decide', approved });
      const decision = { id: pending.id, approved, note };
      if ('agent' in source) {
        for await (const event of source.agent.approvals.streamResolve(decision, { signal })) emit(event);
        return;
      }
      const url = `${options.approvalsUrl}/${encodeURIComponent(pending.id)}`;
      await relayContinuation(await post(source, url, { approved, note }, signal), emit);
    });
  };

  const stop = () => controller?.abort();
  const reset = () => {
    controller?.abort();
    controller = null;
    cached = null;
    host.dispatch({ type: 'ui.reset' });
  };

  return { send, stop, reset, approve: (note) => decide(true, note), reject: (note) => decide(false, note), answer: (text) => decide(true, text) };
}
