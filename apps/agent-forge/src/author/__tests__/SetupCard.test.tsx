import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act } from 'react';

const mocks = vi.hoisted(() => ({ chat: null as unknown as import('../AuthorChatContext').AuthorChat }));
vi.mock('../AuthorChatContext', () => ({ useAuthorChat: () => mocks.chat }));

import { DockProvider } from '../../shell/Dock';
import { AuthorPanel } from '../AuthorPanel';
import { SetupCard } from '../SetupCard';
import { initialAuthorChatState, type AuthorChatState } from '../authorChatReducer';
import { installMemoryStorage } from '../../ui/__tests__/memoryStorage';
import { render } from '../../ui/__tests__/render';
import type { AuthorChat } from '../AuthorChatContext';
import type { AuthorUserMessage } from '../../../shared/authorWire';

/** A chat whose actions are spies; state overrides merge over a ready baseline. */
function chatWith(state: Partial<AuthorChatState> = {}): AuthorChat {
  return {
    state: { ...initialAuthorChatState, connection: 'open', setup: { ready: true }, ...state },
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

function user(text: string): AuthorUserMessage {
  return { id: 'm_u_1', role: 'user', text, at: '2026-01-01T00:00:00.000Z' };
}

beforeEach(() => {
  installMemoryStorage();
  window.location.hash = '#/';
});

describe('SetupCard', () => {
  it('shows the title and the Anthropic hint with the configured model', () => {
    const c = render(
      <SetupCard model="anthropic/claude-sonnet-5-5" missingKeyFor="anthropic" onRecheck={vi.fn()} />
    );
    expect(c.querySelector('.setup-card-title')?.textContent).toBe('Add an API key to use the Agent Author');
    expect(c.querySelector('.setup-card-hint')?.textContent).toBe(
      'The Author runs on anthropic/claude-sonnet-5-5. Add an Anthropic key in Settings, or pick another model there.'
    );
  });

  it('names OpenAI and OpenRouter keys', () => {
    let c = render(<SetupCard model="openai/gpt-5" missingKeyFor="openai" onRecheck={vi.fn()} />);
    expect(c.querySelector('.setup-card-hint')?.textContent).toContain('Add an OpenAI key in Settings');
    c = render(<SetupCard model="openrouter/anthropic/claude-sonnet-5-5" missingKeyFor="openrouter" onRecheck={vi.fn()} />);
    expect(c.querySelector('.setup-card-hint')?.textContent).toContain('Add an OpenRouter key in Settings');
  });

  it('falls back to a generic key line for a provider without a known name', () => {
    const c = render(<SetupCard model="ollama/llama3" onRecheck={vi.fn()} />);
    expect(c.querySelector('.setup-card-hint')?.textContent).toBe(
      'The Author runs on ollama/llama3. Add an API key in Settings, or pick another model there.'
    );
  });

  it('Open Settings navigates to /settings and Check again calls onRecheck', () => {
    const onRecheck = vi.fn();
    const c = render(<SetupCard model="anthropic/claude-sonnet-5-5" onRecheck={onRecheck} />);
    const buttons = [...c.querySelectorAll<HTMLButtonElement>('.setup-card-actions button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Open Settings', 'Check again']);
    act(() => buttons[0]!.click());
    expect(window.location.hash).toBe('#/settings');
    act(() => buttons[1]!.click());
    expect(onRecheck).toHaveBeenCalledTimes(1);
  });
});

describe('SetupCard in the AuthorPanel', () => {
  function mount(chat: AuthorChat): HTMLDivElement {
    mocks.chat = chat;
    return render(
      <DockProvider>
        <AuthorPanel />
      </DockProvider>
    );
  }

  it('shows the card instead of messages and disables the composer when setup is not ready', () => {
    const chat = chatWith({
      setup: { ready: false, missingKeyFor: 'anthropic', model: 'anthropic/claude-sonnet-5-5' },
      messages: [user('hello')],
    });
    const c = mount(chat);
    const body = c.querySelector('.author-body')!;
    expect(body.querySelector('.setup-card')).not.toBeNull();
    expect(body.querySelector('.author-messages')).toBeNull();
    expect(body.querySelector('.author-empty')).toBeNull();
    expect(body.querySelector('.setup-card-hint')?.textContent).toContain('an Anthropic key');
    expect(c.querySelector<HTMLTextAreaElement>('.author-input')?.disabled).toBe(true);
    expect(c.querySelector<HTMLButtonElement>('.author-send')?.disabled).toBe(true);
    expect(c.querySelector<HTMLButtonElement>('.author-send')?.getAttribute('title')).toBe(
      'Add an API key in Settings first'
    );
  });

  it('Check again re-queries the settings through chat.recheckSetup', () => {
    const chat = chatWith({ setup: { ready: false, missingKeyFor: 'openai', model: 'openai/gpt-5' } });
    const c = mount(chat);
    const check = [...c.querySelectorAll<HTMLButtonElement>('.setup-card button')].find(
      (b) => b.textContent === 'Check again'
    )!;
    act(() => check.click());
    expect(chat.recheckSetup).toHaveBeenCalledTimes(1);
  });

  it('a ready setup shows the conversation, not the card', () => {
    const c = mount(chatWith({ setup: { ready: true } }));
    expect(c.querySelector('.setup-card')).toBeNull();
    expect(c.querySelector('.author-empty')).not.toBeNull();
  });
});
