/**
 * `serveAcp()` - serve an agent over the Agent Client Protocol (ACP v1,
 * agentclientprotocol.com): JSON-RPC 2.0, one JSON message per line (LOU-Z6).
 * Transport-independent: it reads lines from `input` and hands each outgoing
 * line to `write`; `loushy acp` wires them to stdin and stdout.
 */
import type { SimpleAgent } from '../createAgent';
import type { AgentEvent, AgentEventOf, AgentEventType } from '../execution/agentEvents';
import type { AgentSession } from '../session/AgentSession';
import type { AgentStore } from '../storage/agentStore';
import { newId } from '../utils/id';

/** Options of {@link serveAcp}. */
export interface ServeAcpOptions {
  /** Incoming lines (each one JSON-RPC message), e.g. a readline interface over stdin. */
  input: AsyncIterable<string>;
  /** Sends one outgoing JSON-RPC message (without its trailing newline). */
  write: (line: string) => void;
  /** Where the ACP sessions' transcripts live; default the agent's own `store`, or memory. */
  store?: Required<AgentStore>;
}

type Json = Record<string, unknown>;
type Id = string | number | null;
interface RpcMessage {
  id?: Id;
  method?: string;
  params?: Json;
  result?: Json;
  error?: unknown;
}
interface AcpSession {
  sdk: AgentSession;
  abort?: AbortController;
  /** An `ask_question` the previous turn ended on: the next prompt answers it. */
  question?: string;
}
type Paused = AgentEventOf<'approval.requested'>;
interface Outcome {
  finishReason: string;
  paused?: Paused;
  error?: string;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: Json
  ) {
    super(message);
  }
}

const STOP_REASONS: Record<string, string> = {
  'max-steps': 'max_turn_requests',
  'budget-exceeded': 'max_tokens',
  length: 'max_tokens',
  guardrail: 'refusal',
  content_filter: 'refusal',
  aborted: 'cancelled',
};
const PERMISSION_OPTIONS = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];

const text = (value: string) => ({ type: 'text', text: value });
const toolOutput = (value: string) => [{ type: 'content', content: text(value) }];
const show = (value: unknown) => (typeof value === 'string' ? value : (JSON.stringify(value) ?? 'null'));

type Updates = { [K in AgentEventType]?: (event: AgentEventOf<K>) => Json | undefined };
/** How the run's events become `session/update`s; a sub-agent's own events stay inside its tool call. */
const UPDATES: Updates = {
  'text.delta': (e) => (e.text ? { sessionUpdate: 'agent_message_chunk', content: text(e.text) } : undefined),
  'reasoning.delta': (e) => (e.text ? { sessionUpdate: 'agent_thought_chunk', content: text(e.text) } : undefined),
  'tool.start': (e) => ({ sessionUpdate: 'tool_call', toolCallId: e.toolCallId, title: e.toolName, kind: 'other', status: 'in_progress', rawInput: e.args }),
  'tool.done': (e) => ({ sessionUpdate: 'tool_call_update', toolCallId: e.toolCallId, status: 'completed', content: toolOutput(show(e.result)), rawOutput: e.result }),
  'tool.error': (e) => ({ sessionUpdate: 'tool_call_update', toolCallId: e.toolCallId, status: 'failed', content: toolOutput(e.error.message), rawOutput: { error: e.error.message } }),
};

/** How prompt blocks become text: text blocks as they are, `resource_link` blocks as Markdown links; others are dropped. */
const BLOCK_TEXT: Record<string, (block: Json) => string> = {
  text: (block) => String(block.text ?? ''),
  resource_link: (block) => `[${String(block.name ?? block.uri)}](${String(block.uri)})`,
};

function promptText(blocks: unknown): string {
  const parts = (Array.isArray(blocks) ? (blocks as Json[]) : []).map((block) => BLOCK_TEXT[String(block.type)]?.(block) ?? '');
  const joined = parts.filter(Boolean).join('\n');
  if (!joined) throw new RpcError(-32602, 'session/prompt needs at least one text or resource_link block.');
  return joined;
}

function toRpcError(error: unknown): Json {
  if (error instanceof RpcError) return { code: error.code, message: error.message, ...(error.data && { data: error.data }) };
  const message = error instanceof Error ? error.message : String(error);
  return { code: -32603, message, data: { code: /\[([A-Z][A-Z0-9_]+)\]/.exec(message)?.[1] ?? 'LOUSHY_GENERIC_ERROR' } };
}

/**
 * Serves `agent` over ACP until `input` ends. One ACP session is one SDK
 * session (`agent.session()`), so its prompts share history. Tool approvals
 * become `session/request_permission` requests; an `ask_question` pause ends
 * the turn with the question as the agent's message and the next prompt answers it.
 */
export async function serveAcp(agent: SimpleAgent, options: ServeAcpOptions): Promise<void> {
  const { write, store } = options;
  const sessions = new Map<string, AcpSession>();
  const waiting = new Map<string, (message: RpcMessage) => void>();
  const inFlight = new Set<Promise<unknown>>();
  let nextRequest = 0;
  const send = (message: Json) => write(JSON.stringify({ jsonrpc: '2.0', ...message }));
  const update = (sessionId: string, payload: Json) => send({ method: 'session/update', params: { sessionId, update: payload } });

  /** Sends a request to the client; an abort settles it as `cancelled`. */
  function request(method: string, params: Json, signal: AbortSignal): Promise<RpcMessage> {
    const id = `loushy-${nextRequest++}`;
    return new Promise((resolve) => {
      const settle = (message: RpcMessage) => (waiting.delete(id), resolve(message));
      const cancelled = () => settle({ result: { outcome: { outcome: 'cancelled' } } });
      if (signal.aborted) return cancelled();
      signal.addEventListener('abort', cancelled, { once: true });
      waiting.set(id, settle);
      send({ id, method, params });
    });
  }

  function sessionOf(params: Json): [string, AcpSession] {
    const id = String(params.sessionId);
    const session = sessions.get(id);
    if (!session) throw new RpcError(-32602, `Unknown sessionId '${id}'.`);
    return [id, session];
  }

  /** Forwards a run's events as `session/update`s; resolves to how it ended. */
  async function relay(sessionId: string, events: AsyncIterable<AgentEvent>): Promise<Outcome> {
    const outcome: Outcome = { finishReason: 'stop' };
    for await (const event of events) {
      const payload = event.subagent ? undefined : (UPDATES[event.type] as ((e: AgentEvent) => Json | undefined) | undefined)?.(event);
      if (payload) update(sessionId, payload);
      if (event.type === 'approval.requested') outcome.paused = event;
      if (event.type === 'error') outcome.error = event.error.message;
      if (event.type === 'run.done') outcome.finishReason = event.finishReason;
    }
    return outcome;
  }

  /** Asks the client about a paused tool call; true when it chose `allow`. */
  async function permit(sessionId: string, paused: Paused, signal: AbortSignal): Promise<boolean> {
    const toolCall = { toolCallId: paused.toolCallId, title: paused.toolName, kind: 'other', status: 'pending', rawInput: paused.args };
    const reply = await request('session/request_permission', { sessionId, toolCall, options: PERMISSION_OPTIONS }, signal);
    const outcome = reply.result?.outcome as Json | undefined;
    const allowed = outcome?.outcome === 'selected' && outcome.optionId === 'allow';
    if (!allowed) update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: paused.toolCallId, status: 'failed', content: toolOutput('Rejected by the user.') });
    return allowed;
  }

  /** Ends the turn on a question: shows it and remembers that the next prompt answers it. */
  function ask(sessionId: string, session: AcpSession, paused: Paused): Outcome {
    const { text: question = '', options: choices = [] } = paused.question ?? {};
    session.question = paused.approvalId;
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: text([question, ...choices.map((c, i) => `${i + 1}. ${c}`)].join('\n')) });
    return { finishReason: 'stop' };
  }

  async function turn(sessionId: string, session: AcpSession, input: string, signal: AbortSignal): Promise<Outcome> {
    const question = session.question;
    session.question = undefined;
    const events = question ? agent.approvals.streamAnswer({ id: question, answer: input }, { signal }) : session.sdk.stream(input, { signal });
    let outcome = await relay(sessionId, events);
    while (outcome.paused) {
      const { paused } = outcome;
      if (paused.kind === 'question') return ask(sessionId, session, paused);
      const approved = await permit(sessionId, paused, signal);
      // After a cancel the decision runs under the aborted signal: it settles the approval and stops at once.
      outcome = await relay(sessionId, agent.approvals.streamResolve({ id: paused.approvalId, approved }, { signal }));
    }
    return outcome;
  }

  async function prompt(params: Json): Promise<Json> {
    const [sessionId, session] = sessionOf(params);
    const input = promptText(params.prompt);
    if (session.abort) throw new RpcError(-32600, `Session '${sessionId}' is already running a prompt.`);
    const controller = (session.abort = new AbortController());
    try {
      const outcome = await turn(sessionId, session, input, controller.signal);
      if (controller.signal.aborted) return { stopReason: 'cancelled' };
      if (outcome.finishReason === 'error') throw new Error(outcome.error ?? 'The run failed.');
      return { stopReason: STOP_REASONS[outcome.finishReason] ?? 'end_turn' };
    } finally {
      session.abort = undefined;
    }
  }

  const methods: Record<string, (params: Json) => Json | Promise<Json>> = {
    initialize: () => ({
      protocolVersion: 1,
      agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
      authMethods: [],
    }),
    'session/new': () => {
      const sessionId = `acp-${newId()}`;
      sessions.set(sessionId, { sdk: agent.session(store ? { id: sessionId, store } : { id: sessionId }) });
      return { sessionId };
    },
    'session/prompt': prompt,
  };
  const notifications: Record<string, (params: Json) => void> = {
    'session/cancel': (params) => sessions.get(String(params.sessionId))?.abort?.abort(),
  };

  function dispatch(message: RpcMessage): void {
    const { id, method, params = {} } = message;
    if (method === undefined) return void (id !== undefined && waiting.get(String(id))?.(message));
    if (id === undefined) return void notifications[method]?.(params);
    const handler = methods[method];
    const reply = handler
      ? Promise.resolve()
          .then(() => handler(params))
          .then((result) => send({ id, result }), (error: unknown) => send({ id, error: toRpcError(error) }))
      : Promise.resolve(send({ id, error: { code: -32601, message: `Method not found: ${method}` } }));
    inFlight.add(reply);
    void reply.finally(() => inFlight.delete(reply));
  }

  for await (const line of options.input) {
    if (!line.trim()) continue;
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      send({ id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    dispatch(message);
  }
  // The client went away: stop what is running and let it settle.
  for (const session of sessions.values()) session.abort?.abort();
  await Promise.allSettled([...inFlight]);
}
