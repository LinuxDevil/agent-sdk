/**
 * Pure state-update logic for the Agent Author conversation, in the
 * house style of state/chatReducer.ts (no React, no sockets - every
 * decision is testable in isolation). `AuthorChatContext` owns the only
 * instance, kept above the dock so a panel close never loses the chat.
 *
 * Two message sources merge here: the optimistic `local-<requestId>`
 * user message a send writes before the socket answers, and the server
 * events of one turn at a time. `acceptEvent` (AA04) drops replayed
 * frames below `active.lastSeq`; `transcript.reconciled` then swaps in
 * the stored transcript at every terminal event, so optimistic ids and
 * streamed parts always converge on server truth.
 *
 * A seq-0 `turn.error` is a per-socket reply, never part of a turn: it
 * means the `chat.send` itself was refused (BUSY, NO_PROVIDER_KEY,
 * OFFLINE...), so the optimistic message comes back out and its text
 * returns to the composer via `restoreDraft`. A seq->0 `turn.error` is
 * the turn's own terminal event instead.
 */
import {
  DEFAULT_SESSION_TITLE,
  type AuthorAssistantMessage,
  type AuthorFocus,
  type AuthorMessage,
  type AuthorServerEvent,
  type AuthorSessionRecord,
  type AuthorToolPart,
  type AuthorUiEvent,
  type AuthorUserMessage,
  type RequestSecretOutput,
} from '../../shared/authorWire';
import { acceptEvent } from './reattach';

/** The one turn in flight: what streamed so far, and the dedupe cursor. */
export interface ActiveTurn {
  requestId: string;
  /** The highest `seq` applied so far (0 = the send is unacknowledged). */
  lastSeq: number;
  /** The assistant message the live events are assembling. */
  assistant: AuthorAssistantMessage;
}

/** Everything the Author dock and its cards render. */
export interface AuthorChatState {
  sessionId: string | null;
  title: string;
  focus: AuthorFocus;
  /** Settled messages (server truth after a reconcile). */
  messages: AuthorMessage[];
  /** The streaming turn, or null between turns. */
  active: ActiveTurn | null;
  connection: 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';
  /**
   * The note the ErrorNote strip shows. `retry` marks a mid-turn death
   * (a seq->0 `turn.error`): the composer offers "Try again", resending
   * the last user text. Send refusals (seq 0) and the reattach give-up
   * leave it unset - the draft is already back in the composer or the
   * note is informational only.
   */
  error: { message: string; code?: string; retry?: true } | null;
  /** Composer text to put back after a refused send. */
  restoreDraft: string | null;
  /** Whether the configured Author model can run (the setup card's input). */
  setup: { ready: boolean; missingKeyFor?: string; model?: string } | null;
  /** The proposal save in flight (Apply is single-shot per click). */
  saving: { proposalId: string } | null;
  /** Save refusals by proposalId - the card that failed shows them. */
  saveErrors: Record<string, { message: string; code?: string; latestProposalId?: string }>;
}

export type AuthorChatAction =
  | { type: 'session.loaded'; record: AuthorSessionRecord }
  | { type: 'session.reset'; focus: AuthorFocus }
  | { type: 'focus.set'; focus: AuthorFocus }
  | { type: 'user.sent'; requestId: string; message: AuthorUserMessage }
  | { type: 'server.event'; event: AuthorServerEvent }
  | { type: 'connection'; state: AuthorChatState['connection'] }
  | { type: 'transcript.reconciled'; record: AuthorSessionRecord }
  | { type: 'setup'; ready: boolean; missingKeyFor?: string; model?: string }
  | { type: 'save.started'; proposalId: string }
  | { type: 'save.succeeded'; message: AuthorUserMessage }
  | { type: 'save.failed'; proposalId: string; message: string; code?: string; latestProposalId?: string }
  | { type: 'secret.answered'; toolCallId: string; outcome: 'saved' | 'declined' }
  | { type: 'error.dismissed' };

/** The state a fresh app (and New chat) starts from. */
export const initialAuthorChatState: AuthorChatState = {
  sessionId: null,
  title: DEFAULT_SESSION_TITLE,
  focus: { mode: 'create' },
  messages: [],
  active: null,
  connection: 'idle',
  error: null,
  restoreDraft: null,
  setup: null,
  saving: null,
  saveErrors: {},
};

/** The not-yet-persisted assistant message a live turn assembles into. */
function liveAssistant(requestId: string, at: string): AuthorAssistantMessage {
  return { id: `live-${requestId}`, role: 'assistant', parts: [], at, requestId };
}

/** A record's `runningRequestId` as an `ActiveTurn` shell for replayed events to fill. */
function turnShell(requestId: string, at: string): ActiveTurn {
  return { requestId, lastSeq: 0, assistant: liveAssistant(requestId, at) };
}

/** The optimistic `local-<requestId>` id a send's user message carries. */
function localMessageId(requestId: string): string {
  return `local-${requestId}`;
}

/** Shared record fields for `session.loaded` and `transcript.reconciled`. */
function recordSlice(
  state: AuthorChatState,
  record: AuthorSessionRecord
): Pick<AuthorChatState, 'sessionId' | 'title' | 'focus' | 'messages' | 'active'> {
  return {
    sessionId: record.id,
    title: record.title,
    focus: record.focus,
    messages: record.transcript,
    // A turn still running locally keeps its streamed parts; a different
    // (or newly reported) running reply starts as a shell the resume fills.
    active:
      record.runningRequestId === null
        ? null
        : state.active?.requestId === record.runningRequestId
          ? state.active
          : turnShell(record.runningRequestId, record.updatedAt),
  };
}

/** `active` for `requestId`: the live one, a lazily opened shell, or null for a different turn's events. */
function activeFor(state: AuthorChatState, requestId: string): ActiveTurn | null {
  if (state.active === null) return turnShell(requestId, new Date().toISOString());
  return state.active.requestId === requestId ? state.active : null;
}

function withParts(state: AuthorChatState, active: ActiveTurn, parts: AuthorAssistantMessage['parts']): AuthorChatState {
  return { ...state, active: { ...active, assistant: { ...active.assistant, parts } } };
}

/** Map one tool part (by `toolCallId`) inside a part list; pushes a synthesised part when absent. */
function mapToolPart(
  parts: AuthorAssistantMessage['parts'],
  event: { toolCallId: string; name: string; input?: unknown },
  update: (part: AuthorToolPart) => AuthorToolPart
): AuthorAssistantMessage['parts'] {
  const index = parts.findIndex((p) => p.type === 'tool' && p.toolCallId === event.toolCallId);
  if (index === -1) {
    return [...parts, update({ type: 'tool', toolCallId: event.toolCallId, name: event.name, input: event.input, state: 'pending' })];
  }
  return parts.map((p, i) => (i === index && p.type === 'tool' ? update(p) : p));
}

function onTurnStarted(state: AuthorChatState, event: Extract<AuthorServerEvent, { type: 'turn.started' }>): AuthorChatState {
  if (state.active?.requestId === event.requestId) return state;
  return {
    ...state,
    active: { requestId: event.requestId, lastSeq: event.seq, assistant: liveAssistant(event.requestId, new Date().toISOString()) },
  };
}

function onTextDelta(state: AuthorChatState, event: Extract<AuthorServerEvent, { type: 'text.delta' }>): AuthorChatState {
  const active = activeFor(state, event.requestId);
  if (active === null) return state;
  const parts = [...active.assistant.parts];
  const last = parts[parts.length - 1];
  if (last?.type === 'text') {
    parts[parts.length - 1] = { ...last, text: last.text + event.text };
  } else {
    parts.push({ type: 'text', text: event.text });
  }
  return withParts(state, active, parts);
}

function onToolCall(state: AuthorChatState, event: Extract<AuthorServerEvent, { type: 'tool.call' }>): AuthorChatState {
  const active = activeFor(state, event.requestId);
  if (active === null) return state;
  const part: AuthorToolPart = { type: 'tool', toolCallId: event.toolCallId, name: event.name, input: event.input, state: 'pending' };
  return withParts(state, active, [...active.assistant.parts, part]);
}

function onToolResult(state: AuthorChatState, event: Extract<AuthorServerEvent, { type: 'tool.result' }>): AuthorChatState {
  const active = activeFor(state, event.requestId);
  if (active === null) return state;
  const parts = mapToolPart(active.assistant.parts, event, (part) => ({ ...part, output: event.output, state: event.state }));
  return withParts(state, active, parts);
}

function onToolPending(state: AuthorChatState, event: Extract<AuthorServerEvent, { type: 'tool.pending' }>): AuthorChatState {
  const active = activeFor(state, event.requestId);
  if (active === null) return state;
  const parts = mapToolPart(active.assistant.parts, event, (part) => ({ ...part, state: 'pending' }));
  return withParts(state, active, parts);
}

/** `turn.finished` and a seq->0 `turn.error`: the streaming turn settles into `messages`. */
function settleTurn(state: AuthorChatState, event: { requestId: string }, finishReason: string): AuthorChatState {
  if (state.active === null || state.active.requestId !== event.requestId) return state;
  const { assistant } = state.active;
  const messages =
    assistant.parts.length === 0 ? state.messages : [...state.messages, { ...assistant, finishReason }];
  return { ...state, messages, active: null };
}

function onTurnFinished(state: AuthorChatState, event: Extract<AuthorServerEvent, { type: 'turn.finished' }>): AuthorChatState {
  return settleTurn(state, event, event.finishReason);
}

/**
 * A refused send: the server (or the offline socket) answered the
 * `chat.send` itself with a seq-0 error. The optimistic `local-` message
 * comes back out and its text returns to the composer via `restoreDraft`.
 * `requestId: ''` (a malformed-frame refusal) only counts while the
 * send is still unacknowledged (`lastSeq === 0`) - after that the frame
 * belonged to something else.
 */
function onSendRefused(state: AuthorChatState, event: Extract<AuthorServerEvent, { type: 'turn.error' }>): AuthorChatState {
  const error = event.code === undefined ? { message: event.message } : { message: event.message, code: event.code };
  const targetId = event.requestId !== '' ? event.requestId : (state.active?.requestId ?? '');
  const refusedActive =
    state.active !== null &&
    state.active.requestId === targetId &&
    (event.requestId !== '' || state.active.lastSeq === 0);
  const optimisticIndex = state.messages.findIndex((m) => m.id === localMessageId(targetId));
  if (!refusedActive && optimisticIndex === -1) {
    // A per-socket error that isn't about our send (e.g. UNKNOWN_REQUEST
    // answering a `chat.resume`): the note is all it changes.
    return { ...state, error };
  }
  const removed = optimisticIndex === -1 ? undefined : state.messages[optimisticIndex];
  return {
    ...state,
    messages: optimisticIndex === -1 ? state.messages : state.messages.filter((_, i) => i !== optimisticIndex),
    active: refusedActive ? null : state.active,
    restoreDraft: removed?.role === 'user' ? removed.text : state.restoreDraft,
    error,
    // NO_PROVIDER_KEY flips the setup card on; the model/provider the
    // bootstrap already reported stay so the card can still name them.
    setup: event.code === 'NO_PROVIDER_KEY' ? { ...state.setup, ready: false } : state.setup,
  };
}

function onTurnError(state: AuthorChatState, event: Extract<AuthorServerEvent, { type: 'turn.error' }>): AuthorChatState {
  if (event.seq === 0) return onSendRefused(state, event);
  const settled = settleTurn(state, event, 'error');
  const error =
    event.code === undefined
      ? { message: event.message, retry: true as const }
      : { message: event.message, code: event.code, retry: true as const };
  return { ...settled, error };
}

/** One handler per event type - the lookup keeps each under the complexity ceiling. */
const EVENT_HANDLERS: {
  [K in AuthorServerEvent['type']]: (state: AuthorChatState, event: Extract<AuthorServerEvent, { type: K }>) => AuthorChatState;
} = {
  'turn.started': onTurnStarted,
  'text.delta': onTextDelta,
  'tool.call': onToolCall,
  'tool.result': onToolResult,
  'tool.pending': onToolPending,
  'turn.finished': onTurnFinished,
  'turn.error': onTurnError,
};

function onServerEvent(state: AuthorChatState, event: AuthorServerEvent): AuthorChatState {
  if (!acceptEvent(state.active?.lastSeq ?? 0, state.active?.requestId ?? null, event)) return state;
  const next = (EVENT_HANDLERS[event.type] as (s: AuthorChatState, e: AuthorServerEvent) => AuthorChatState)(state, event);
  if (event.seq > 0 && next.active !== null && next.active.requestId === event.requestId && next.active.lastSeq < event.seq) {
    return { ...next, active: { ...next.active, lastSeq: event.seq } };
  }
  return next;
}

/** The `name` a settled secret part's input carried (`requestSecret`'s `{ name, why }`). */
function secretNameOf(part: AuthorToolPart): string {
  const name = (part.input as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' ? name : '';
}

/** The output a `secret.answered` writes on the card's part - the same payload the server persists. */
function secretOutcomeOutput(name: string, outcome: 'saved' | 'declined'): RequestSecretOutput {
  if (outcome === 'saved') return { ok: true, name, status: 'saved' };
  return {
    ok: false,
    code: 'DECLINED',
    name,
    error: `The user chose not to enter ${name} now.`,
    userMessage: 'Skipped for now.',
  };
}

/** Settle the `toolCallId` part to `done` with `output`, in place across a part list. */
function settlePart(parts: AuthorAssistantMessage['parts'], toolCallId: string, output: RequestSecretOutput): AuthorAssistantMessage['parts'] {
  return parts.map((p) => (p.type === 'tool' && p.toolCallId === toolCallId ? { ...p, state: 'done' as const, output } : p));
}

function onSecretAnswered(
  state: AuthorChatState,
  action: Extract<AuthorChatAction, { type: 'secret.answered' }>
): AuthorChatState {
  const candidates: AuthorToolPart[] = [];
  for (const message of state.messages) {
    if (message.role === 'assistant') {
      candidates.push(...message.parts.filter((p): p is AuthorToolPart => p.type === 'tool'));
    }
  }
  if (state.active !== null) {
    candidates.push(...state.active.assistant.parts.filter((p): p is AuthorToolPart => p.type === 'tool'));
  }
  const part = candidates.find((p) => p.toolCallId === action.toolCallId && p.state === 'pending');
  if (part === undefined) return state;
  const output = secretOutcomeOutput(secretNameOf(part), action.outcome);
  return {
    ...state,
    messages: state.messages.map((m) =>
      m.role === 'assistant' ? { ...m, parts: settlePart(m.parts, action.toolCallId, output) } : m
    ),
    active:
      state.active === null
        ? null
        : {
            ...state.active,
            assistant: { ...state.active.assistant, parts: settlePart(state.active.assistant.parts, action.toolCallId, output) },
          },
  };
}

/** The `proposalId` a `save.succeeded` message clears from `saveErrors`, when it is a save uiEvent. */
function savedProposalId(message: AuthorUserMessage): string | undefined {
  const uiEvent: AuthorUiEvent | undefined = message.uiEvent;
  return uiEvent?.kind === 'save' ? uiEvent.proposalId : undefined;
}

export function authorChatReducer(state: AuthorChatState, action: AuthorChatAction): AuthorChatState {
  switch (action.type) {
    case 'session.loaded':
      return { ...initialAuthorChatState, ...recordSlice(state, action.record), setup: state.setup };
    case 'session.reset':
      return { ...initialAuthorChatState, focus: action.focus, setup: state.setup };
    case 'focus.set':
      return { ...state, focus: action.focus };
    case 'user.sent':
      return {
        ...state,
        messages: [...state.messages, action.message],
        restoreDraft: null,
        // The send is in flight from this dispatch: `active` exists before
        // `turn.started` so a seq-0 refusal can find it (and Apply stays shut).
        active: {
          requestId: action.requestId,
          lastSeq: 0,
          assistant: liveAssistant(action.requestId, action.message.at),
        },
      };
    case 'server.event':
      return onServerEvent(state, action.event);
    case 'connection':
      return { ...state, connection: action.state };
    case 'transcript.reconciled':
      return { ...state, ...recordSlice(state, action.record) };
    case 'setup': {
      const setup: NonNullable<AuthorChatState['setup']> = { ready: action.ready };
      if (action.missingKeyFor !== undefined) setup.missingKeyFor = action.missingKeyFor;
      if (action.model !== undefined) setup.model = action.model;
      return { ...state, setup };
    }
    case 'save.started': {
      const saveErrors = { ...state.saveErrors };
      delete saveErrors[action.proposalId];
      return { ...state, saving: { proposalId: action.proposalId }, saveErrors };
    }
    case 'save.succeeded': {
      const saveErrors = { ...state.saveErrors };
      const proposalId = savedProposalId(action.message);
      if (proposalId !== undefined) delete saveErrors[proposalId];
      return { ...state, saving: null, saveErrors, messages: [...state.messages, action.message] };
    }
    case 'save.failed': {
      const entry: { message: string; code?: string; latestProposalId?: string } = { message: action.message };
      if (action.code !== undefined) entry.code = action.code;
      if (action.latestProposalId !== undefined) entry.latestProposalId = action.latestProposalId;
      return { ...state, saving: null, saveErrors: { ...state.saveErrors, [action.proposalId]: entry } };
    }
    case 'secret.answered':
      return onSecretAnswered(state, action);
    case 'error.dismissed':
      return { ...state, error: null, restoreDraft: null };
  }
}
