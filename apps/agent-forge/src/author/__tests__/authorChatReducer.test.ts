import { describe, it, expect } from 'vitest';
import {
  authorChatReducer,
  initialAuthorChatState,
  type AuthorChatState,
} from '../authorChatReducer';
import type {
  AuthorAssistantMessage,
  AuthorServerEvent,
  AuthorSessionRecord,
  AuthorUserMessage,
} from '../../../shared/authorWire';

const RECORD: AuthorSessionRecord = {
  schemaVersion: 1,
  id: 'sess-1',
  title: 'First chat',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:01:00.000Z',
  workspaceId: 'ws-1',
  focus: { mode: 'edit', agentId: 'agent-a' },
  transcript: [
    { id: 'm_1', role: 'user', text: 'make it faster', at: '2026-01-01T00:00:10.000Z' },
    {
      id: 'm_2',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Done.' }],
      at: '2026-01-01T00:00:20.000Z',
      requestId: 'r_old',
      finishReason: 'stop',
    },
  ],
  createdAgentIds: [],
  runningRequestId: null,
};

function userSent(state: AuthorChatState, requestId: string, text: string): AuthorChatState {
  const message: AuthorUserMessage = {
    id: `local-${requestId}`,
    role: 'user',
    text,
    at: '2026-01-01T00:00:00.000Z',
  };
  return authorChatReducer(state, { type: 'user.sent', requestId, message });
}

function apply(state: AuthorChatState, events: AuthorServerEvent[]): AuthorChatState {
  return events.reduce((s, event) => authorChatReducer(s, { type: 'server.event', event }), state);
}

const TURN_EVENTS: AuthorServerEvent[] = [
  { type: 'turn.started', requestId: 'r_1', seq: 1 },
  { type: 'text.delta', requestId: 'r_1', seq: 2, text: 'Hello' },
  { type: 'text.delta', requestId: 'r_1', seq: 3, text: ', world' },
  { type: 'tool.call', requestId: 'r_1', seq: 4, toolCallId: 'tc_1', name: 'listAgents', input: {} },
  {
    type: 'tool.result',
    requestId: 'r_1',
    seq: 5,
    toolCallId: 'tc_1',
    name: 'listAgents',
    output: { agents: [] },
    state: 'done',
  },
  { type: 'text.delta', requestId: 'r_1', seq: 6, text: 'All listed.' },
  { type: 'turn.finished', requestId: 'r_1', seq: 7, finishReason: 'stop' },
];

describe('authorChatReducer', () => {
  it('initial state: no session, create focus, idle connection, New chat title', () => {
    expect(initialAuthorChatState).toEqual({
      sessionId: null,
      title: 'New chat',
      focus: { mode: 'create' },
      messages: [],
      active: null,
      connection: 'idle',
      error: null,
      restoreDraft: null,
      setup: null,
      saving: null,
      saveErrors: {},
    });
  });

  it('user.sent pushes the optimistic message and marks the turn in flight', () => {
    const state = userSent(initialAuthorChatState, 'r_1', 'hi');
    expect(state.messages).toEqual([
      { id: 'local-r_1', role: 'user', text: 'hi', at: '2026-01-01T00:00:00.000Z' },
    ]);
    expect(state.active).toMatchObject({ requestId: 'r_1', lastSeq: 0 });
    expect(state.active?.assistant.parts).toEqual([]);
  });

  it('turn.started for a new requestId opens the streaming turn', () => {
    const state = apply(initialAuthorChatState, [{ type: 'turn.started', requestId: 'r_9', seq: 1 }]);
    expect(state.active).toMatchObject({
      requestId: 'r_9',
      lastSeq: 1,
      assistant: { id: 'live-r_9', role: 'assistant', parts: [], requestId: 'r_9' },
    });
  });

  it('text.delta merges consecutive deltas and opens a new part after a tool part', () => {
    const state = apply(userSent(initialAuthorChatState, 'r_1', 'hi'), TURN_EVENTS.slice(0, 6));
    const parts = state.active!.assistant.parts;
    expect(parts).toEqual([
      { type: 'text', text: 'Hello, world' },
      { type: 'tool', toolCallId: 'tc_1', name: 'listAgents', input: {}, output: { agents: [] }, state: 'done' },
      { type: 'text', text: 'All listed.' },
    ]);
    expect(state.active?.lastSeq).toBe(6);
  });

  it('tool.call opens a pending part; tool.pending keeps it pending', () => {
    const sent = userSent(initialAuthorChatState, 'r_1', 'hi');
    const called = apply(sent, [
      { type: 'turn.started', requestId: 'r_1', seq: 1 },
      { type: 'tool.call', requestId: 'r_1', seq: 2, toolCallId: 'tc_1', name: 'requestSecret', input: { name: 'API_KEY' } },
    ]);
    expect(called.active?.assistant.parts[0]).toEqual({
      type: 'tool',
      toolCallId: 'tc_1',
      name: 'requestSecret',
      input: { name: 'API_KEY' },
      state: 'pending',
    });
    const pending = apply(called, [
      { type: 'tool.pending', requestId: 'r_1', seq: 3, toolCallId: 'tc_1', name: 'requestSecret', input: { name: 'API_KEY' } },
    ]);
    expect((pending.active!.assistant.parts[0] as { state: string }).state).toBe('pending');
  });

  it('tool.result settles the matching part with its output and state', () => {
    const sent = userSent(initialAuthorChatState, 'r_1', 'hi');
    const state = apply(sent, [
      { type: 'turn.started', requestId: 'r_1', seq: 1 },
      { type: 'tool.call', requestId: 'r_1', seq: 2, toolCallId: 'tc_1', name: 'saveAgent', input: {} },
      {
        type: 'tool.result',
        requestId: 'r_1',
        seq: 3,
        toolCallId: 'tc_1',
        name: 'saveAgent',
        output: { ok: false, code: 'UNANSWERED' },
        state: 'error',
      },
    ]);
    expect(state.active?.assistant.parts[0]).toMatchObject({ state: 'error', output: { ok: false } });
  });

  it('turn.finished moves the assembled assistant message into messages and clears active', () => {
    const state = apply(userSent(initialAuthorChatState, 'r_1', 'hi'), TURN_EVENTS);
    expect(state.active).toBeNull();
    const assistant = state.messages.at(-1) as AuthorAssistantMessage;
    expect(assistant.role).toBe('assistant');
    expect(assistant.finishReason).toBe('stop');
    expect(assistant.parts).toHaveLength(3);
    expect(assistant.requestId).toBe('r_1');
  });

  it('turn.finished with no parts leaves no assistant message', () => {
    const state = apply(userSent(initialAuthorChatState, 'r_1', 'hi'), [
      { type: 'turn.started', requestId: 'r_1', seq: 1 },
      { type: 'turn.finished', requestId: 'r_1', seq: 2, finishReason: 'stopped' },
    ]);
    expect(state.active).toBeNull();
    expect(state.messages).toHaveLength(1); // only the user message
  });

  it('turn.error with seq > 0 finishes the turn as error and sets the error note', () => {
    const state = apply(userSent(initialAuthorChatState, 'r_1', 'hi'), [
      { type: 'turn.started', requestId: 'r_1', seq: 1 },
      { type: 'text.delta', requestId: 'r_1', seq: 2, text: 'partial' },
      { type: 'turn.error', requestId: 'r_1', seq: 3, message: 'provider died', code: 'UNAVAILABLE' },
    ]);
    expect(state.active).toBeNull();
    // `retry` marks a mid-turn death: the panel offers "Try again" (resends the last user text).
    expect(state.error).toEqual({ message: 'provider died', code: 'UNAVAILABLE', retry: true });
    const assistant = state.messages.at(-1) as AuthorAssistantMessage;
    expect(assistant.finishReason).toBe('error');
  });

  it('a refused send (seq-0 BUSY) removes the optimistic message and restores the draft', () => {
    const sent = userSent(initialAuthorChatState, 'r_1', 'make it faster');
    const state = apply(sent, [
      { type: 'turn.error', requestId: 'r_1', seq: 0, message: 'A reply is already running.', code: 'BUSY' },
    ]);
    expect(state.messages).toEqual([]);
    expect(state.active).toBeNull();
    expect(state.restoreDraft).toBe('make it faster');
    expect(state.error).toEqual({ message: 'A reply is already running.', code: 'BUSY' });
  });

  it('a seq-0 NO_PROVIDER_KEY refusal flips setup to not ready', () => {
    const sent = userSent(initialAuthorChatState, 'r_1', 'hi');
    const state = apply(sent, [
      { type: 'turn.error', requestId: 'r_1', seq: 0, message: 'No key.', code: 'NO_PROVIDER_KEY' },
    ]);
    expect(state.setup).toEqual({ ready: false });
    expect(state.restoreDraft).toBe('hi');
  });

  it('a seq-0 error for another requestId only notes the error', () => {
    const sent = userSent(initialAuthorChatState, 'r_1', 'hi');
    const state = apply(sent, [
      { type: 'turn.error', requestId: 'r_old', seq: 0, message: 'This reply is no longer available.', code: 'UNKNOWN_REQUEST' },
    ]);
    expect(state.error?.code).toBe('UNKNOWN_REQUEST');
    // The pending send's optimistic message and active turn are untouched.
    expect(state.messages).toHaveLength(1);
    expect(state.active?.requestId).toBe('r_1');
  });

  it('replaying the same events twice leaves state identical (seq dedupe)', () => {
    const sent = userSent(initialAuthorChatState, 'r_1', 'hi');
    // Live delivery reached seq 4 before the drop; the resume then replays
    // the whole turn - seqs 1-4 are dropped, 5-7 apply exactly once.
    const live = apply(sent, TURN_EVENTS.slice(0, 4));
    const replayed = apply(live, TURN_EVENTS);
    const fresh = apply(live, TURN_EVENTS.slice(4));
    expect(replayed).toEqual(fresh);
  });

  it('replayed mid-turn events are dropped by seq, not re-applied', () => {
    const sent = userSent(initialAuthorChatState, 'r_1', 'hi');
    const mid = apply(sent, TURN_EVENTS.slice(0, 4));
    const replayed = apply(mid, TURN_EVENTS.slice(0, 4));
    const parts = (replayed.active!.assistant.parts) as Array<{ type: string; text?: string }>;
    expect(parts[0]).toEqual({ type: 'text', text: 'Hello, world' });
  });

  it('a terminal event re-sent for a settled turn changes nothing', () => {
    // The resume answer for a settled turn is its terminal event alone -
    // arriving a second time it must not resurrect or duplicate anything.
    const settled = apply(userSent(initialAuthorChatState, 'r_1', 'hi'), TURN_EVENTS);
    const again = apply(settled, [TURN_EVENTS[TURN_EVENTS.length - 1]]);
    expect(again).toEqual(settled);
  });

  it('session.loaded adopts the record and marks a running reply active', () => {
    const running = { ...RECORD, runningRequestId: 'r_live' };
    const state = authorChatReducer(initialAuthorChatState, { type: 'session.loaded', record: running });
    expect(state.sessionId).toBe('sess-1');
    expect(state.title).toBe('First chat');
    expect(state.focus).toEqual({ mode: 'edit', agentId: 'agent-a' });
    expect(state.messages).toBe(RECORD.transcript);
    expect(state.active).toMatchObject({ requestId: 'r_live', lastSeq: 0 });
  });

  it('transcript.reconciled replaces messages with the server transcript, keeping the error note', () => {
    const errored = { ...initialAuthorChatState, error: { message: 'x' } };
    const state = authorChatReducer(errored, { type: 'transcript.reconciled', record: RECORD });
    expect(state.messages).toBe(RECORD.transcript);
    expect(state.sessionId).toBe('sess-1');
    expect(state.active).toBeNull();
    expect(state.error).toEqual({ message: 'x' });
  });

  it('session.reset clears the conversation but keeps the setup state', () => {
    const busy = {
      ...initialAuthorChatState,
      setup: { ready: true },
      error: { message: 'x' },
      messages: RECORD.transcript,
      sessionId: 'sess-1',
    };
    const state = authorChatReducer(busy, { type: 'session.reset', focus: { mode: 'create' } });
    expect(state.sessionId).toBeNull();
    expect(state.messages).toEqual([]);
    expect(state.error).toBeNull();
    expect(state.setup).toEqual({ ready: true });
  });

  it('focus.set, connection and setup update their slices', () => {
    let state = authorChatReducer(initialAuthorChatState, {
      type: 'focus.set',
      focus: { mode: 'edit', agentId: 'a' },
    });
    expect(state.focus).toEqual({ mode: 'edit', agentId: 'a' });
    state = authorChatReducer(state, { type: 'connection', state: 'reconnecting' });
    expect(state.connection).toBe('reconnecting');
    state = authorChatReducer(state, { type: 'setup', ready: false, missingKeyFor: 'anthropic' });
    expect(state.setup).toEqual({ ready: false, missingKeyFor: 'anthropic' });
  });

  it('save actions track saving and per-proposal errors', () => {
    let state = authorChatReducer(initialAuthorChatState, { type: 'save.started', proposalId: 'p_1' });
    expect(state.saving).toEqual({ proposalId: 'p_1' });

    state = authorChatReducer(state, {
      type: 'save.failed',
      proposalId: 'p_1',
      message: 'stale',
      code: 'STALE_PROPOSAL',
      latestProposalId: 'p_2',
    });
    expect(state.saving).toBeNull();
    expect(state.saveErrors.p_1).toEqual({
      message: 'stale',
      code: 'STALE_PROPOSAL',
      latestProposalId: 'p_2',
    });

    const uiMessage: AuthorUserMessage = {
      id: 'm_save',
      role: 'user',
      text: '',
      at: '2026-01-01T00:02:00.000Z',
      uiEvent: { kind: 'save', proposalId: 'p_2', agentId: 'agent-a', version: 3 },
    };
    state = authorChatReducer(state, { type: 'save.started', proposalId: 'p_2' });
    state = authorChatReducer(state, { type: 'save.succeeded', message: uiMessage });
    expect(state.saving).toBeNull();
    expect(state.messages.at(-1)).toBe(uiMessage);
  });

  it('secret.answered settles the pending requestSecret part to done', () => {
    const assistant: AuthorAssistantMessage = {
      id: 'm_a',
      role: 'assistant',
      parts: [
        {
          type: 'tool',
          toolCallId: 'tc_s',
          name: 'requestSecret',
          input: { name: 'OPENAI_KEY', why: 'model' },
          state: 'pending',
        },
      ],
      at: '2026-01-01T00:00:00.000Z',
    };
    const withCard = { ...initialAuthorChatState, messages: [assistant] as AuthorChatState['messages'] };
    const state = authorChatReducer(withCard, {
      type: 'secret.answered',
      toolCallId: 'tc_s',
      outcome: 'saved',
    });
    const part = (state.messages[0] as AuthorAssistantMessage).parts[0];
    expect(part).toMatchObject({ state: 'done', output: { ok: true, name: 'OPENAI_KEY', status: 'saved' } });
  });

  it('secret.answered declined stores the DECLINED output on the part', () => {
    const sent = userSent(initialAuthorChatState, 'r_1', 'hi');
    const withCard = apply(sent, [
      { type: 'turn.started', requestId: 'r_1', seq: 1 },
      { type: 'tool.pending', requestId: 'r_1', seq: 2, toolCallId: 'tc_s', name: 'requestSecret', input: { name: 'K' } },
    ]);
    const state = authorChatReducer(withCard, {
      type: 'secret.answered',
      toolCallId: 'tc_s',
      outcome: 'declined',
    });
    const part = state.active!.assistant.parts[0];
    expect(part).toMatchObject({ state: 'done', output: { ok: false, code: 'DECLINED', name: 'K' } });
  });

  it('error.dismissed clears the note and any restored draft', () => {
    const state = authorChatReducer(
      { ...initialAuthorChatState, error: { message: 'x' }, restoreDraft: 'hi' },
      { type: 'error.dismissed' }
    );
    expect(state.error).toBeNull();
    expect(state.restoreDraft).toBeNull();
  });
});
