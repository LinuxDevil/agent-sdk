/**
 * The one Author conversation for the whole app. The provider mounts
 * inside `AppShell` (above the dock, below `ToastProvider`), so the chat
 * survives navigation and panel close - "closing is a pause, not an end".
 * The reducer (authorChatReducer.ts) owns state transitions; this file
 * owns everything stateful that isn't renderable: the reconnecting
 * socket, the localStorage session id, the AA04 reattach pass and the
 * `POST /save|enable|secret` actions.
 *
 * Reattach (research §1.10): every socket open checks the
 * `loadPendingRequest()` marker and the session record's
 * `runningRequestId`; a match sends `chat.resume` and replays through the
 * reducer's `acceptEvent` dedupe. A terminal event - or
 * `REATTACH_TIMEOUT_MS` of silence - ends the pass with a transcript
 * reconcile; while a pass runs, `onAgentSaved` is suppressed so a
 * replayed `tool.result` never re-fires a save that already landed.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import type {
  AuthorClientMessage,
  AuthorFocus,
  AuthorSecretRequest,
  AuthorServerEvent,
  AuthorSettingsPayload,
  AuthorUserMessage,
  SetEnabledOutput,
} from '../../shared/authorWire';
import { connectAuthorStream, newRequestId, type AuthorStream } from './authorStream';
import {
  authorChatReducer,
  initialAuthorChatState,
  type AuthorChatAction,
  type AuthorChatState,
} from './authorChatReducer';
import { resetAuthorFocusCleared } from './authorEntry';
import { fireAgentSaved, fireOpenPage } from './authorEvents';
import {
  loadPendingRequest,
  REATTACH_GAVE_UP,
  REATTACH_MAX_ATTEMPTS,
  REATTACH_TIMEOUT_MS,
  savePendingRequest,
  streamEndRecovery,
} from './reattach';
import { runtimeClient, RuntimeApiError } from '../runtime/runtimeClient';

/** The localStorage key holding the open chat's session id (survives reload). */
export const AUTHOR_SESSION_KEY = 'forge.author.sessionId';

/** The seq-0 `turn.error` the provider synthesises when `send()` finds no open socket. */
const OFFLINE_MESSAGE = "You're offline. Your message wasn't sent.";

/** `tool.result` names that count as an Author-driven agent save (the `onAgentSaved` trigger). */
const SAVE_TOOL_NAMES = new Set(['saveAgent', 'saveAgentUpdate', 'setAgentEnabled']);

/** The Author dock's actions and renderable state. */
export interface AuthorChat {
  state: AuthorChatState;
  /** True while a turn is in flight (`state.active !== null`). */
  isStreaming: boolean;
  /** Sends `text` - creating the session on first use - and streams the reply. */
  send(text: string): void;
  /** Stops the running turn (`chat.stop`). */
  stop(): void;
  /** Clears the chat; the next send creates the session file. */
  newChat(focus?: AuthorFocus): void;
  /** Opens a stored session by id; rejects when it no longer exists. */
  openSession(id: string): Promise<void>;
  setFocus(focus: AuthorFocus): void;
  /** The card's Apply button; a no-op while a turn streams or a save runs. */
  apply(proposalId: string): Promise<void>;
  /** The SuccessCard's "Enable agent" button; null when there is no session. */
  enable(agentId: string): Promise<SetEnabledOutput | null>;
  /** The SecretCard's submit; `value: null` skips the card (`declined`). */
  submitSecret(toolCallId: string, name: string, value: string | null): Promise<void>;
  /** The SetupCard's "Check again": re-reads `GET /settings/author` and dispatches its answer. */
  recheckSetup(): void;
  dismissError(): void;
}

const AuthorChatContext = createContext<AuthorChat | null>(null);

/** `AUTHOR_SESSION_KEY` read - every storage access is try/catch (denied storage must not break the chat). */
function readSessionId(): string | null {
  try {
    return window.localStorage.getItem(AUTHOR_SESSION_KEY);
  } catch {
    return null;
  }
}

/** `AUTHOR_SESSION_KEY` write (`null` removes it). */
function writeSessionId(id: string | null): void {
  try {
    if (id === null) {
      window.localStorage.removeItem(AUTHOR_SESSION_KEY);
      return;
    }
    window.localStorage.setItem(AUTHOR_SESSION_KEY, id);
  } catch {
    // Storage denied: the chat works, it just won't reopen after a reload.
  }
}

/** The `setup` dispatch a `GET /settings/author` answer produces (`model` names what the card says runs). */
function setupAction(settings: AuthorSettingsPayload): AuthorChatAction {
  const action: Extract<AuthorChatAction, { type: 'setup' }> = { type: 'setup', ready: settings.ready, model: settings.model };
  if (settings.missingKeyFor !== undefined) action.missingKeyFor = settings.missingKeyFor;
  return action;
}

/** A `tool.result` counts as a save when the tool wrote an agent and reported `ok`. */
function savedAgentIdOf(event: Extract<AuthorServerEvent, { type: 'tool.result' }>): string | undefined {
  if (!SAVE_TOOL_NAMES.has(event.name)) return undefined;
  const output = event.output as { ok?: unknown; agentId?: unknown } | undefined;
  return output?.ok === true && typeof output.agentId === 'string' ? output.agentId : undefined;
}

/** A live `openPage` `tool.result` with `ok: true` carries the `{ path }` the app navigates to. */
function openPagePathOf(event: Extract<AuthorServerEvent, { type: 'tool.result' }>): string | undefined {
  if (event.name !== 'openPage') return undefined;
  const output = event.output as { ok?: unknown; path?: unknown } | undefined;
  return output?.ok === true && typeof output.path === 'string' ? output.path : undefined;
}

/** Mounts the Author conversation once, above every screen and the dock. */
export function AuthorChatProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, dispatch] = useReducer(authorChatReducer, initialAuthorChatState);
  // Stream callbacks read the latest state through refs - they outlive renders.
  const stateRef = useRef(state);
  stateRef.current = state;
  const streamRef = useRef<{ sessionId: string; stream: AuthorStream } | null>(null);
  // Set before connectAuthorStream runs, so even its synchronous first
  // 'connecting' onState is accepted instead of read as a stale stream's.
  const liveSessionRef = useRef<string | null>(null);
  const connectionRef = useRef<AuthorChatState['connection']>('idle');
  const openWaitersRef = useRef<Array<() => void>>([]);
  const reattachRef = useRef<{ sessionId: string; requestId: string; attempts: number } | null>(null);
  const reattachTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRequestRef = useRef<string | null>(null);

  function clearReattach(): void {
    if (reattachTimerRef.current !== null) {
      clearTimeout(reattachTimerRef.current);
      reattachTimerRef.current = null;
    }
    reattachRef.current = null;
  }

  function closeStream(): void {
    liveSessionRef.current = null;
    clearReattach();
    const current = streamRef.current;
    streamRef.current = null;
    current?.stream.close();
  }

  function ensureStream(sessionId: string): AuthorStream {
    const current = streamRef.current;
    if (current !== null && current.sessionId === sessionId) return current.stream;
    closeStream();
    liveSessionRef.current = sessionId;
    const live = (): boolean => liveSessionRef.current === sessionId;
    const stream = connectAuthorStream(sessionId, {
      onEvent: (event) => {
        if (live()) handleServerEvent(sessionId, event);
      },
      onState: (next) => {
        if (!live()) return;
        connectionRef.current = next;
        const waiters = openWaitersRef.current;
        openWaitersRef.current = [];
        for (const resolve of waiters) resolve();
        dispatch({ type: 'connection', state: next });
      },
      onOpen: () => {
        if (live()) void onStreamOpen(sessionId);
      },
    });
    streamRef.current = { sessionId, stream };
    return stream;
  }

  /** Apply the event, fire `onAgentSaved` for a live save result, and close out a terminal turn. */
  function handleServerEvent(sessionId: string, event: AuthorServerEvent): void {
    dispatch({ type: 'server.event', event });
    if (event.type === 'tool.result' && reattachRef.current === null) {
      const agentId = savedAgentIdOf(event);
      if (agentId !== undefined) fireAgentSaved(agentId);
      const path = openPagePathOf(event);
      if (path !== undefined) fireOpenPage(path);
    }
    if (event.type === 'turn.finished' || event.type === 'turn.error') onTerminalEvent(sessionId, event);
  }

  /**
   * Every terminal event: drop the pending marker, end any reattach pass
   * it answers, and reconcile the transcript against the stored record
   * (server truth replaces the optimistic ids). A seq-0 refusal skips the
   * fetch - the send never ran, so the transcript cannot have changed -
   * except `UNKNOWN_REQUEST`, which exists exactly to trigger one.
   */
  function onTerminalEvent(
    sessionId: string,
    event: Extract<AuthorServerEvent, { type: 'turn.finished' | 'turn.error' }>
  ): void {
    if (reattachRef.current?.requestId === event.requestId) clearReattach();
    const pending = loadPendingRequest();
    if (pending?.sessionId === sessionId) savePendingRequest(null);
    const recovery = streamEndRecovery({
      wasStreaming: event.seq > 0,
      socketClosed: connectionRef.current !== 'open',
      errorCode: event.type === 'turn.error' ? event.code : undefined,
      stoppedByUser: stoppedRequestRef.current === event.requestId,
    });
    stoppedRequestRef.current = null;
    if (recovery === 'busy') {
      // Our send was refused because another reply runs in this chat -
      // reattach to that reply instead of leaving the user staring at it.
      void reattachRunning(sessionId);
      return;
    }
    if (event.type === 'turn.finished' || event.seq > 0 || event.code === 'UNKNOWN_REQUEST') {
      void reconcileSession(sessionId);
    }
  }

  /** `GET /assistant/sessions/:id` → `transcript.reconciled` (server truth replaces optimistic ids). */
  async function reconcileSession(sessionId: string): Promise<void> {
    try {
      const record = await runtimeClient.getAuthorSession(sessionId);
      if (stateRef.current.sessionId !== sessionId) return;
      dispatch({ type: 'transcript.reconciled', record });
    } catch {
      // A reconcile miss keeps the streamed state - nothing is lost yet.
    }
  }

  /**
   * Every socket open: resume the turn this tab was sending (the
   * localStorage marker) or the one the server still reports running.
   * `chat.resume` answers with the missed events - replayed live, the
   * settled turn's terminal event, or `UNKNOWN_REQUEST` (→ reconcile).
   */
  async function onStreamOpen(sessionId: string): Promise<void> {
    const pending = loadPendingRequest();
    if (pending !== null && pending.sessionId === sessionId) {
      startResume(sessionId, pending.requestId, pending.lastSeq);
      return;
    }
    try {
      const record = await runtimeClient.getAuthorSession(sessionId);
      if (stateRef.current.sessionId !== sessionId || record.runningRequestId === null) return;
      const lastSeq =
        stateRef.current.active?.requestId === record.runningRequestId ? stateRef.current.active.lastSeq : 0;
      startResume(sessionId, record.runningRequestId, lastSeq);
    } catch {
      // The record is unreachable for now; the next (re)connect retries.
    }
  }

  /** The BUSY-refusal path: the running reply's id comes from the record, not the marker. */
  async function reattachRunning(sessionId: string): Promise<void> {
    try {
      const record = await runtimeClient.getAuthorSession(sessionId);
      if (stateRef.current.sessionId !== sessionId) return;
      dispatch({ type: 'transcript.reconciled', record });
      if (record.runningRequestId !== null) startResume(sessionId, record.runningRequestId, 0);
    } catch {
      // The running reply's outcome will reach us on the next reconnect.
    }
  }

  /**
   * One `chat.resume` plus its silence timer. `reattachRef` doubles as
   * the `onAgentSaved` suppressor: while a pass runs, every incoming
   * `tool.result` may be a buffer replay, so none of them count as a
   * fresh save.
   */
  function startResume(sessionId: string, requestId: string, afterSeq: number): void {
    const current = streamRef.current;
    if (current === null || current.sessionId !== sessionId) return;
    if (reattachRef.current?.requestId === requestId) return;
    reattachRef.current = { sessionId, requestId, attempts: 0 };
    current.stream.send({ type: 'chat.resume', requestId, afterSeq });
    reattachTimerRef.current = setTimeout(() => void onReattachTimeout(), REATTACH_TIMEOUT_MS);
  }

  /**
   * Silence after `chat.resume`: reconcile now, and if the record still
   * reports the reply running, resume again - up to
   * `REATTACH_MAX_ATTEMPTS`, then `REATTACH_GAVE_UP` as the error note.
   */
  async function onReattachTimeout(): Promise<void> {
    const rt = reattachRef.current;
    if (rt === null) return;
    reattachTimerRef.current = null;
    reattachRef.current = null; // the reconcile below is truth, not replay
    let record;
    try {
      record = await runtimeClient.getAuthorSession(rt.sessionId);
    } catch {
      record = undefined;
    }
    if (record !== undefined && stateRef.current.sessionId === rt.sessionId) {
      dispatch({ type: 'transcript.reconciled', record });
    }
    if (record?.runningRequestId != null && rt.attempts + 1 < REATTACH_MAX_ATTEMPTS) {
      reattachRef.current = { ...rt, attempts: rt.attempts + 1 };
      streamRef.current?.stream.send({
        type: 'chat.resume',
        requestId: rt.requestId,
        afterSeq: stateRef.current.active?.lastSeq ?? 0,
      });
      reattachTimerRef.current = setTimeout(() => void onReattachTimeout(), REATTACH_TIMEOUT_MS);
      return;
    }
    if (record?.runningRequestId != null) {
      dispatch({
        type: 'server.event',
        event: { type: 'turn.error', requestId: rt.requestId, seq: 0, message: REATTACH_GAVE_UP },
      });
    }
  }

  /** The session a send needs, creating it (and persisting its id) on first use. */
  async function ensureSession(): Promise<string | null> {
    if (stateRef.current.sessionId !== null) return stateRef.current.sessionId;
    try {
      const session = await runtimeClient.createAuthorSession(stateRef.current.focus);
      dispatch({ type: 'session.loaded', record: { ...session, runningRequestId: null } });
      writeSessionId(session.id);
      return session.id;
    } catch {
      dispatch({
        type: 'server.event',
        event: {
          type: 'turn.error',
          requestId: '',
          seq: 0,
          message: 'The chat could not be created. Try again.',
          code: 'SESSION_FAILED',
        },
      });
      return null;
    }
  }

  /**
   * `stream.send`, but when the socket is still on its first connect it
   * waits one transition: a fresh session's very first `chat.send` races
   * the handshake, and failing it OFFLINE would be wrong. A socket that
   * is `reconnecting`/`closed` returns `false` at once - that IS offline.
   */
  async function sendWhenOpen(stream: AuthorStream, message: AuthorClientMessage): Promise<boolean> {
    if (stream.send(message)) return true;
    if (connectionRef.current !== 'connecting') return false;
    await new Promise<void>((resolve) => {
      openWaitersRef.current.push(resolve);
    });
    return stream.send(message);
  }

  async function doSend(text: string): Promise<void> {
    const sessionId = await ensureSession();
    if (sessionId === null) return;
    const requestId = newRequestId();
    const message: AuthorUserMessage = {
      id: `local-${requestId}`,
      role: 'user',
      text,
      at: new Date().toISOString(),
    };
    dispatch({ type: 'user.sent', requestId, message });
    const sent = await sendWhenOpen(ensureStream(sessionId), {
      type: 'chat.send',
      requestId,
      text,
      focus: stateRef.current.focus,
    });
    if (!sent) {
      dispatch({
        type: 'server.event',
        event: { type: 'turn.error', requestId, seq: 0, message: OFFLINE_MESSAGE, code: 'OFFLINE' },
      });
      return;
    }
    // The marker is written only once the frame is on the wire: it means
    // "a chat.send the server may have", and a resumed unknown requestId
    // answers UNKNOWN_REQUEST.
    savePendingRequest({ sessionId, requestId, lastSeq: 0 });
  }

  async function doOpenSession(id: string): Promise<void> {
    if (stateRef.current.saving !== null) return;
    const record = await runtimeClient.getAuthorSession(id); // 404 rejects - the history row shows it
    if (stateRef.current.saving !== null) return; // a save started while the record loaded
    closeStream();
    dispatch({ type: 'session.loaded', record });
    writeSessionId(id);
    ensureStream(id);
  }

  async function doApply(proposalId: string): Promise<void> {
    const current = stateRef.current;
    if (current.sessionId === null || current.active !== null || current.saving !== null) return;
    dispatch({ type: 'save.started', proposalId });
    try {
      const res = await runtimeClient.saveProposal(current.sessionId, proposalId);
      dispatch({ type: 'save.succeeded', message: res.message });
      fireAgentSaved(res.agentId);
    } catch (error) {
      const failure: { type: 'save.failed'; proposalId: string; message: string; code?: string; latestProposalId?: string } = {
        type: 'save.failed',
        proposalId,
        message: error instanceof Error ? error.message : 'The save failed. Try again.',
      };
      if (error instanceof RuntimeApiError) {
        if (error.code !== undefined) failure.code = error.code;
        const latest = (error.details as { latestProposalId?: unknown } | undefined)?.latestProposalId;
        if (typeof latest === 'string') failure.latestProposalId = latest;
      }
      dispatch(failure);
    }
  }

  async function doSubmitSecret(toolCallId: string, name: string, value: string | null): Promise<void> {
    const sessionId = stateRef.current.sessionId;
    if (sessionId === null) return;
    const body: AuthorSecretRequest =
      value === null ? { toolCallId, name, declined: true } : { toolCallId, name, value };
    // The 204 means the card's part settled and the uiEvent message was
    // appended server-side; the continuation turn arrives over the socket.
    await runtimeClient.submitAuthorSecret(sessionId, body);
    dispatch({ type: 'secret.answered', toolCallId, outcome: value === null ? 'declined' : 'saved' });
  }

  /** `GET /settings/author` → the `setup` state the SetupCard reads (`model` names what runs). */
  async function recheckSettings(): Promise<void> {
    try {
      const settings = await runtimeClient.getAuthorSettings();
      dispatch(setupAction(settings));
    } catch {
      // Settings unreachable: `setup` keeps its last answer.
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function bootstrap(): Promise<void> {
      try {
        const settings = await runtimeClient.getAuthorSettings();
        if (cancelled) return;
        dispatch(setupAction(settings));
      } catch {
        // Settings unreachable: `setup` stays null and no setup card shows.
      }
      const stored = readSessionId();
      if (stored === null) return;
      try {
        const record = await runtimeClient.getAuthorSession(stored);
        if (cancelled) return;
        dispatch({ type: 'session.loaded', record });
        ensureStream(stored);
      } catch (error) {
        if (error instanceof RuntimeApiError && error.status === 404) writeSessionId(null);
      }
    }
    void bootstrap();
    return () => {
      cancelled = true;
      closeStream();
    };
    // Mount-only bootstrap: everything it touches is a ref or dispatch.
  }, []);

  const value = useMemo<AuthorChat>(
    () => ({
      state,
      isStreaming: state.active !== null,
      send: (text: string) => {
        void doSend(text);
      },
      stop: () => {
        const active = stateRef.current.active;
        if (active === null) return;
        stoppedRequestRef.current = active.requestId;
        streamRef.current?.stream.send({ type: 'chat.stop', requestId: active.requestId });
      },
      newChat: (focus?: AuthorFocus) => {
        if (stateRef.current.saving !== null) return;
        // A new chat re-arms route focus: the cleared flag only lasts "in this chat" (AA19).
        resetAuthorFocusCleared();
        closeStream();
        writeSessionId(null);
        dispatch({ type: 'session.reset', focus: focus ?? { mode: 'create' } });
      },
      openSession: (id: string) => doOpenSession(id),
      setFocus: (focus: AuthorFocus) => dispatch({ type: 'focus.set', focus }),
      apply: (proposalId: string) => doApply(proposalId),
      enable: (agentId: string) => {
        const sessionId = stateRef.current.sessionId;
        return sessionId === null ? Promise.resolve(null) : runtimeClient.enableAuthorAgent(sessionId, agentId);
      },
      submitSecret: (toolCallId: string, name: string, value: string | null) => doSubmitSecret(toolCallId, name, value),
      recheckSetup: () => {
        void recheckSettings();
      },
      dismissError: () => dispatch({ type: 'error.dismissed' }),
    }),
    // The actions read through refs; only `state` changes the value.
    [state]
  );

  return <AuthorChatContext.Provider value={value}>{children}</AuthorChatContext.Provider>;
}

/** The Author conversation; throws outside `AuthorChatProvider`. */
export function useAuthorChat(): AuthorChat {
  const chat = useContext(AuthorChatContext);
  if (chat === null) {
    throw new Error('useAuthorChat must be used inside <AuthorChatProvider>');
  }
  return chat;
}
