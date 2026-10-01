import { describe, it, expect } from 'vitest';
import { applyChatState, emptyChatState } from '../chatReducer';
import type { ChatMessage, ChatStatePayload } from '../../../shared/wireTypes';

function msg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: overrides.id ?? Math.random().toString(36),
    role: 'user',
    content: 'hi',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function payload(overrides: Partial<ChatStatePayload> = {}): ChatStatePayload {
  return { agentId: 'agent-1', sessionId: 'session-1', messages: [], ...overrides };
}

describe('emptyChatState', () => {
  it('starts with no session and no messages', () => {
    expect(emptyChatState()).toEqual({ sessionId: undefined, messages: [] });
  });
});

describe('applyChatState', () => {
  it('adopts a first push for a brand-new state', () => {
    const next = applyChatState(emptyChatState(), payload({ messages: [msg({ id: '1' })] }));
    expect(next.sessionId).toBe('session-1');
    expect(next.messages.map((m) => m.id)).toEqual(['1']);
  });

  it('replaces messages when a later push for the same session has more messages', () => {
    const first = applyChatState(emptyChatState(), payload({ messages: [msg({ id: '1' })] }));
    const second = applyChatState(first, payload({ messages: [msg({ id: '1' }), msg({ id: '2' })] }));
    expect(second.messages.map((m) => m.id)).toEqual(['1', '2']);
  });

  it('drops a stale, out-of-order push for the same session with FEWER messages than already shown', () => {
    const first = applyChatState(emptyChatState(), payload({ messages: [msg({ id: '1' }), msg({ id: '2' })] }));
    const stale = applyChatState(first, payload({ messages: [msg({ id: '1' })] }));
    expect(stale).toBe(first);
    expect(stale.messages.map((m) => m.id)).toEqual(['1', '2']);
  });

  it('always adopts a push for a DIFFERENT session, even with fewer messages (e.g. a fresh "new chat")', () => {
    const first = applyChatState(emptyChatState(), payload({ sessionId: 'session-1', messages: [msg(), msg()] }));
    const switched = applyChatState(first, payload({ sessionId: 'session-2', messages: [] }));
    expect(switched.sessionId).toBe('session-2');
    expect(switched.messages).toHaveLength(0);
  });
});
