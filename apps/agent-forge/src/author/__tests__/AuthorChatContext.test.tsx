import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { render, rerender } from '../../ui/__tests__/render';
import { installMemoryStorage } from '../../ui/__tests__/memoryStorage';
import {
  AuthorChatProvider,
  useAuthorChat,
  AUTHOR_SESSION_KEY,
  type AuthorChat,
} from '../AuthorChatContext';
import { onAgentSaved, onOpenPage } from '../authorEvents';
import { connectAuthorStream, type AuthorStream, type AuthorStreamHandlers } from '../authorStream';
import { runtimeClient } from '../../runtime/runtimeClient';
import type {
  AuthorClientMessage,
  AuthorServerEvent,
  AuthorSession,
  AuthorSessionRecord,
} from '../../../shared/authorWire';
import { PENDING_REQUEST_KEY } from '../reattach';

vi.mock('../authorStream', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../authorStream')>();
  return { ...actual, connectAuthorStream: vi.fn() };
});

vi.mock('../../runtime/runtimeClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../runtime/runtimeClient')>();
  return {
    ...actual,
    runtimeClient: {
      createAuthorSession: vi.fn(),
      getAuthorSession: vi.fn(),
      getAuthorSettings: vi.fn(),
      saveProposal: vi.fn(),
      submitAuthorSecret: vi.fn(),
      enableAuthorAgent: vi.fn(),
    },
  };
});

/** The socket handle the mocked `connectAuthorStream` hands the provider, plus its handlers. */
interface FakeStream {
  stream: AuthorStream;
  sent: AuthorClientMessage[];
  sessionId: string;
  handlers: AuthorStreamHandlers;
  sendResult: boolean;
}

const streams: FakeStream[] = [];

function SESSION(id: string): AuthorSession {
  return {
    schemaVersion: 1,
    id,
    title: 'New chat',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    workspaceId: 'ws-1',
    focus: { mode: 'create' },
    transcript: [],
    createdAgentIds: [],
  };
}

function RECORD(id: string, over: Partial<AuthorSessionRecord> = {}): AuthorSessionRecord {
  return { ...SESSION(id), runningRequestId: null, ...over };
}

/** Flushes pending microtasks so provider-async work settles inside `act`. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Captures the latest `useAuthorChat()` value for assertions. */
let chat: AuthorChat;
function Probe(): null {
  chat = useAuthorChat();
  return null;
}

function mount(children?: ReactNode): void {
  render(<AuthorChatProvider>{children ?? <Probe />}</AuthorChatProvider>);
}

function emit(stream: FakeStream, event: AuthorServerEvent): void {
  act(() => stream.handlers.onEvent(event));
}

beforeEach(() => {
  streams.length = 0;
  installMemoryStorage();
  vi.mocked(runtimeClient.getAuthorSettings).mockResolvedValue({
    model: 'mock/mock-1',
    reviewModel: 'mock/mock-1',
    reviewEnabled: true,
    ready: true,
  });
  vi.mocked(runtimeClient.getAuthorSession).mockRejectedValue(new Error('no session'));
  vi.mocked(runtimeClient.createAuthorSession).mockImplementation(async () => SESSION(`s_${streams.length + 1}`));
  vi.mocked(connectAuthorStream).mockImplementation((sessionId, handlers) => {
    const fake: FakeStream = {
      sessionId,
      handlers,
      sent: [],
      sendResult: true,
      stream: {
        send: (message: AuthorClientMessage) => {
          if (!fake.sendResult) return false;
          fake.sent.push(message);
          return true;
        },
        close: vi.fn(),
      },
    };
    streams.push(fake);
    return fake.stream;
  });
});

describe('AuthorChatProvider', () => {
  it('fetches author settings on mount and stays idle with no stored session', async () => {
    mount();
    await act(flush);
    expect(runtimeClient.getAuthorSettings).toHaveBeenCalled();
    expect(chat.state.setup).toEqual({ ready: true, model: 'mock/mock-1' });
    expect(chat.state.sessionId).toBeNull();
    expect(connectAuthorStream).not.toHaveBeenCalled();
  });

  it('restores the stored session id on mount and opens its stream', async () => {
    window.localStorage.setItem(AUTHOR_SESSION_KEY, 'sess-9');
    vi.mocked(runtimeClient.getAuthorSession).mockResolvedValue(RECORD('sess-9', { title: 'Old chat' }));
    mount();
    await act(flush);
    expect(chat.state.sessionId).toBe('sess-9');
    expect(chat.state.title).toBe('Old chat');
    expect(connectAuthorStream).toHaveBeenCalledWith('sess-9', expect.anything());
  });

  it('clears the stored id when the session is gone (404)', async () => {
    window.localStorage.setItem(AUTHOR_SESSION_KEY, 'sess-gone');
    const { RuntimeApiError } = await import('../../runtime/runtimeClient');
    vi.mocked(runtimeClient.getAuthorSession).mockRejectedValue(new RuntimeApiError('nope', 404));
    mount();
    await act(flush);
    expect(chat.state.sessionId).toBeNull();
    expect(window.localStorage.getItem(AUTHOR_SESSION_KEY)).toBeNull();
  });

  it('send creates the session once, stores its id, and writes chat.send on the socket', async () => {
    mount();
    await act(flush);
    act(() => chat.send('first'));
    await act(flush);
    expect(runtimeClient.createAuthorSession).toHaveBeenCalledTimes(1);
    expect(chat.state.sessionId).toBe('s_1');
    expect(window.localStorage.getItem(AUTHOR_SESSION_KEY)).toBe('s_1');
    expect(streams[0].sent[0]).toMatchObject({ type: 'chat.send', text: 'first' });

    act(() => chat.send('second'));
    await act(flush);
    expect(runtimeClient.createAuthorSession).toHaveBeenCalledTimes(1);
    expect(streams[0].sent).toHaveLength(2);
    expect(chat.state.messages.filter((m) => m.role === 'user')).toHaveLength(2);
  });

  it('a send while the socket is still connecting waits for open instead of failing', async () => {
    mount();
    await act(flush);
    act(() => chat.send('first'));
    await act(flush);
    const fake = streams[0];
    fake.sendResult = false;
    act(() => fake.handlers.onState('connecting'));
    act(() => chat.send('queued'));
    await act(flush);
    // The send is parked on the handshake: optimistic message shown, no error yet.
    expect(chat.state.error).toBeNull();
    expect(chat.state.messages.filter((m) => m.id.startsWith('local-'))).toHaveLength(2);
    expect(fake.sent.filter((m) => m.type === 'chat.send')).toHaveLength(1);
    fake.sendResult = true;
    act(() => fake.handlers.onState('open'));
    await act(flush);
    expect(fake.sent.filter((m) => m.type === 'chat.send')).toHaveLength(2);
    expect(chat.state.error).toBeNull();
  });

  it('an offline send (socket not open) restores the draft and notes OFFLINE', async () => {
    mount();
    await act(flush);
    act(() => chat.send('first'));
    await act(flush);
    const fake = streams[0];
    fake.sendResult = false;
    act(() => fake.handlers.onState('reconnecting'));
    act(() => chat.send('lost message'));
    await act(flush);
    expect(chat.state.error).toEqual({ message: "You're offline. Your message wasn't sent.", code: 'OFFLINE' });
    expect(chat.state.restoreDraft).toBe('lost message');
    expect(chat.state.messages.filter((m) => m.id.startsWith('local-')).map((m) => (m as { text: string }).text)).toEqual(
      ['first']
    );
    fake.sendResult = true;
  });

  it('turn events stream into state and a finish reconciles to the server transcript', async () => {
    mount();
    await act(flush);
    act(() => chat.send('hi'));
    await act(flush);
    const fake = streams[0];
    const requestId = (fake.sent[0] as { requestId: string }).requestId;
    vi.mocked(runtimeClient.getAuthorSession).mockResolvedValue(
      RECORD('s_1', {
        transcript: [
          { id: 'm_srv', role: 'user', text: 'hi', at: '2026-01-01T00:00:00.000Z' },
          { id: 'm_srv2', role: 'assistant', parts: [{ type: 'text', text: 'Hello' }], at: '2026-01-01T00:00:01.000Z' },
        ],
      })
    );
    emit(fake, { type: 'turn.started', requestId, seq: 1 });
    emit(fake, { type: 'text.delta', requestId, seq: 2, text: 'Hello' });
    expect(chat.isStreaming).toBe(true);
    emit(fake, { type: 'turn.finished', requestId, seq: 3, finishReason: 'stop' });
    await act(flush);
    expect(runtimeClient.getAuthorSession).toHaveBeenCalledWith('s_1');
    expect(chat.state.messages).toHaveLength(2);
    expect(chat.state.messages[0].id).toBe('m_srv'); // optimistic id replaced by server truth
    expect(chat.state.active).toBeNull();
    expect(window.localStorage.getItem(PENDING_REQUEST_KEY)).toBeNull();
  });

  it('apply is a no-op while streaming, then saves and fires onAgentSaved', async () => {
    window.localStorage.setItem(AUTHOR_SESSION_KEY, 'sess-1');
    vi.mocked(runtimeClient.getAuthorSession).mockResolvedValue(RECORD('sess-1'));
    const saved: string[] = [];
    const off = onAgentSaved((agentId) => saved.push(agentId));
    mount();
    await act(flush);
    vi.mocked(runtimeClient.saveProposal).mockResolvedValue({
      ok: true,
      agentId: 'agent-new',
      version: 1,
      name: 'New Agent',
      enabled: false,
      message: {
        id: 'm_save',
        role: 'user',
        text: '',
        at: '2026-01-01T00:00:00.000Z',
        uiEvent: { kind: 'save', proposalId: 'p_1', agentId: 'agent-new', version: 1 },
      },
    });
    await act(async () => {
      await chat.apply('p_1');
    });
    expect(runtimeClient.saveProposal).toHaveBeenCalledWith('sess-1', 'p_1');
    expect(saved).toEqual(['agent-new']);
    expect(chat.state.messages.at(-1)).toMatchObject({ uiEvent: { kind: 'save', proposalId: 'p_1' } });

    // While a turn streams, apply refuses.
    const fake = streams[0];
    const requestId = 'r_live';
    emit(fake, { type: 'turn.started', requestId, seq: 1 });
    await act(async () => {
      await chat.apply('p_2');
    });
    expect(runtimeClient.saveProposal).toHaveBeenCalledTimes(1);
    off();
  });

  it('a save failure lands in saveErrors keyed by proposalId', async () => {
    window.localStorage.setItem(AUTHOR_SESSION_KEY, 'sess-1');
    vi.mocked(runtimeClient.getAuthorSession).mockResolvedValue(RECORD('sess-1'));
    const { RuntimeApiError } = await import('../../runtime/runtimeClient');
    vi.mocked(runtimeClient.saveProposal).mockRejectedValue(
      new RuntimeApiError('A newer card exists.', 400, 'STALE_PROPOSAL', { latestProposalId: 'p_2' })
    );
    mount();
    await act(flush);
    await act(async () => {
      await chat.apply('p_1');
    });
    expect(chat.state.saving).toBeNull();
    expect(chat.state.saveErrors.p_1).toEqual({
      message: 'A newer card exists.',
      code: 'STALE_PROPOSAL',
      latestProposalId: 'p_2',
    });
  });

  it('submitSecret posts the answer and settles the pending card', async () => {
    window.localStorage.setItem(AUTHOR_SESSION_KEY, 'sess-1');
    vi.mocked(runtimeClient.getAuthorSession).mockResolvedValue(
      RECORD('sess-1', {
        transcript: [
          {
            id: 'm_a',
            role: 'assistant',
            parts: [
              { type: 'tool', toolCallId: 'tc_1', name: 'requestSecret', input: { name: 'API_KEY' }, state: 'pending' },
            ],
            at: '2026-01-01T00:00:00.000Z',
          },
        ],
      })
    );
    mount();
    await act(flush);
    await act(async () => {
      await chat.submitSecret('tc_1', 'API_KEY', 'sk-test');
    });
    expect(runtimeClient.submitAuthorSecret).toHaveBeenCalledWith('sess-1', {
      toolCallId: 'tc_1',
      name: 'API_KEY',
      value: 'sk-test',
    });
    const part = (chat.state.messages[0] as { parts: Array<{ state: string; output?: unknown }> }).parts[0];
    expect(part.state).toBe('done');
    expect(part.output).toMatchObject({ ok: true, name: 'API_KEY' });
  });

  it('the conversation survives the panel unmounting (state lives above the dock)', async () => {
    mount(<Probe />);
    await act(flush);
    act(() => chat.send('hi'));
    await act(flush);
    expect(chat.state.messages).toHaveLength(1);
    // The panel unmounts; the provider (and its socket) stay mounted.
    rerender(<AuthorChatProvider>{null}</AuthorChatProvider>);
    rerender(
      <AuthorChatProvider>
        <Probe />
      </AuthorChatProvider>
    );
    expect(chat.state.messages).toHaveLength(1);
    expect(chat.state.sessionId).toBe('s_1');
  });

  it('newChat clears the chat and drops the stored id; openSession loads a record', async () => {
    window.localStorage.setItem(AUTHOR_SESSION_KEY, 'sess-1');
    vi.mocked(runtimeClient.getAuthorSession).mockResolvedValue(RECORD('sess-1'));
    mount();
    await act(flush);
    act(() => chat.newChat());
    expect(chat.state.sessionId).toBeNull();
    expect(window.localStorage.getItem(AUTHOR_SESSION_KEY)).toBeNull();

    vi.mocked(runtimeClient.getAuthorSession).mockResolvedValue(RECORD('sess-2', { title: 'Second' }));
    await act(async () => {
      await chat.openSession('sess-2');
    });
    expect(chat.state.sessionId).toBe('sess-2');
    expect(chat.state.title).toBe('Second');
    expect(streams.at(-1)?.sessionId).toBe('sess-2');
  });

  it('on socket open, a stored pending request resumes its turn', async () => {
    window.localStorage.setItem(AUTHOR_SESSION_KEY, 'sess-1');
    window.localStorage.setItem(
      PENDING_REQUEST_KEY,
      JSON.stringify({ sessionId: 'sess-1', requestId: 'r_pending', lastSeq: 0 })
    );
    vi.mocked(runtimeClient.getAuthorSession).mockResolvedValue(RECORD('sess-1'));
    mount();
    await act(flush);
    const fake = streams[0];
    act(() => fake.handlers.onOpen?.());
    await act(flush);
    expect(fake.sent).toContainEqual({ type: 'chat.resume', requestId: 'r_pending', afterSeq: 0 });
  });

  it('fires onOpenPage for a live openPage result, never for a replayed one', async () => {
    const paths: string[] = [];
    const off = onOpenPage((path) => paths.push(path));
    try {
      window.localStorage.setItem(AUTHOR_SESSION_KEY, 'sess-1');
      window.localStorage.setItem(
        PENDING_REQUEST_KEY,
        JSON.stringify({ sessionId: 'sess-1', requestId: 'r_pending', lastSeq: 0 })
      );
      vi.mocked(runtimeClient.getAuthorSession).mockResolvedValue(RECORD('sess-1'));
      mount();
      await act(flush);
      const fake = streams[0];
      act(() => fake.handlers.onOpen?.());
      await act(flush);
      // A replayed openPage result during the reattach pass must not navigate.
      emit(fake, {
        type: 'tool.result',
        requestId: 'r_pending',
        seq: 2,
        toolCallId: 'tc_old',
        name: 'openPage',
        output: { ok: true, path: '/agents/old' },
        state: 'done',
      });
      expect(paths).toEqual([]);
      // The replay settles; the next live openPage result navigates.
      emit(fake, { type: 'turn.finished', requestId: 'r_pending', seq: 3, finishReason: 'stop' });
      await act(flush);
      emit(fake, {
        type: 'tool.result',
        requestId: 'r_live',
        seq: 1,
        toolCallId: 'tc_new',
        name: 'openPage',
        output: { ok: true, path: '/agents/new' },
        state: 'done',
      });
      expect(paths).toEqual(['/agents/new']);
    } finally {
      off();
    }
  });
});
