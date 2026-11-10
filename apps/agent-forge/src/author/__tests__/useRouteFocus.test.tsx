import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ chat: null as unknown as import('../AuthorChatContext').AuthorChat }));
vi.mock('../AuthorChatContext', () => ({ useAuthorChat: () => mocks.chat }));

import { AuthorRouteFocus } from '../useRouteFocus';
import { markAuthorFocusCleared, resetAuthorFocusCleared, takePendingOpen } from '../authorEntry';
import { initialAuthorChatState } from '../authorChatReducer';
import type { AuthorChat } from '../AuthorChatContext';
import type { AuthorFocus } from '../../../shared/authorWire';
import { render } from '../../ui/__tests__/render';
import { installMemoryStorage } from '../../ui/__tests__/memoryStorage';

/** A chat stub: route focus only reads `state.focus` and calls `setFocus`. */
function chatWith(focus: AuthorFocus = { mode: 'create' }): AuthorChat {
  return {
    state: { ...initialAuthorChatState, focus },
    isStreaming: false,
    send: vi.fn(),
    stop: vi.fn(),
    newChat: vi.fn(),
    openSession: vi.fn(),
    setFocus: vi.fn(),
    apply: vi.fn(),
    enable: vi.fn(),
    submitSecret: vi.fn(),
    recheckSetup: vi.fn(),
    dismissError: vi.fn(),
  };
}

function go(hash: string) {
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

beforeEach(() => {
  installMemoryStorage();
  resetAuthorFocusCleared();
  window.location.hash = '#/';
});

afterEach(() => {
  resetAuthorFocusCleared();
  takePendingOpen();
});

describe('AuthorRouteFocus', () => {
  it('sets edit focus for the agent on an /agents/:id/* route, on mount and on change', () => {
    const chat = chatWith();
    mocks.chat = chat;
    window.location.hash = '#/agents/support-triage/canvas';
    render(<AuthorRouteFocus />);
    expect(chat.setFocus).toHaveBeenCalledWith({ mode: 'edit', agentId: 'support-triage' });
    expect(chat.setFocus).toHaveBeenCalledTimes(1);

    go('#/agents/beta/runs');
    expect(chat.setFocus).toHaveBeenLastCalledWith({ mode: 'edit', agentId: 'beta' });
    expect(chat.setFocus).toHaveBeenCalledTimes(2);
  });

  it('leaves focus unchanged on non-agent routes', () => {
    const chat = chatWith();
    mocks.chat = chat;
    render(<AuthorRouteFocus />);
    go('#/traces');
    go('#/agents'); // the bare list names no agent
    expect(chat.setFocus).not.toHaveBeenCalled();
  });

  it('does not re-dispatch when the focus already names the route agent', () => {
    const chat = chatWith({ mode: 'edit', agentId: 'support-triage' });
    mocks.chat = chat;
    window.location.hash = '#/agents/support-triage/canvas';
    render(<AuthorRouteFocus />);
    expect(chat.setFocus).not.toHaveBeenCalled();
  });

  it('a cleared chip survives further navigation in the same chat', () => {
    const chat = chatWith();
    mocks.chat = chat;
    window.location.hash = '#/agents/support-triage/canvas';
    render(<AuthorRouteFocus />);
    expect(chat.setFocus).toHaveBeenCalledTimes(1);

    markAuthorFocusCleared(); // the chip's clear button
    vi.mocked(chat.setFocus).mockClear();
    go('#/agents/support-triage/runs');
    go('#/agents/beta/canvas');
    expect(chat.setFocus).not.toHaveBeenCalled();
  });

  it('the next new chat re-arms route focus', () => {
    const chat = chatWith();
    mocks.chat = chat;
    window.location.hash = '#/agents/support-triage/canvas';
    render(<AuthorRouteFocus />);
    markAuthorFocusCleared();
    vi.mocked(chat.setFocus).mockClear();

    resetAuthorFocusCleared(); // what AuthorChatContext.newChat calls
    go('#/agents/beta/canvas');
    expect(chat.setFocus).toHaveBeenCalledWith({ mode: 'edit', agentId: 'beta' });
  });
});
