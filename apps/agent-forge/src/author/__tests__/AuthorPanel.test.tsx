import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';

const appState = vi.hoisted(() => ({ connected: true, agents: [] }));
vi.mock('../../state/AppState', () => ({ useAppState: () => appState }));

const mocks = vi.hoisted(() => ({ chat: null as unknown as import('../AuthorChatContext').AuthorChat }));
vi.mock('../AuthorChatContext', () => ({ useAuthorChat: () => mocks.chat }));

import { AppShell } from '../../shell/AppShell';
import { DOCK_OPEN_KEY } from '../../shell/dockState';
import { AuthorPanel } from '../AuthorPanel';
import { fireOpenPage } from '../authorEvents';
import { initialAuthorChatState, type AuthorChatState } from '../authorChatReducer';
import { render, rerender } from '../../ui/__tests__/render';
import { installMemoryStorage } from '../../ui/__tests__/memoryStorage';
import type { AuthorChat } from '../AuthorChatContext';
import type {
  AuthorAssistantMessage,
  AuthorMessage,
  AuthorToolPart,
  AuthorUserMessage,
} from '../../../shared/authorWire';

function stubWide() {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

/** A chat whose actions are spies; state overrides merge over a ready, connected baseline. */
function chatWith(over: Partial<AuthorChatState> = {}): AuthorChat {
  const state: AuthorChatState = {
    ...initialAuthorChatState,
    connection: 'open',
    setup: { ready: true },
    ...over,
  };
  return {
    state,
    isStreaming: state.active !== null,
    send: vi.fn(),
    stop: vi.fn(),
    newChat: vi.fn(),
    openSession: vi.fn(),
    setFocus: vi.fn(),
    apply: vi.fn(),
    enable: vi.fn(),
    submitSecret: vi.fn(),
    dismissError: vi.fn(),
  };
}

function tool(over: Partial<AuthorToolPart>): AuthorToolPart {
  return { type: 'tool', toolCallId: 'tc_1', name: 'getCurrentSpec', input: {}, state: 'done', ...over };
}

function assistant(parts: AuthorAssistantMessage['parts'], finishReason?: string): AuthorAssistantMessage {
  return {
    id: 'm_a1',
    role: 'assistant',
    parts,
    at: '2026-01-01T00:00:00.000Z',
    requestId: 'r1',
    ...(finishReason !== undefined ? { finishReason } : {}),
  };
}

let userSeq = 0;
function user(text: string, uiEvent?: AuthorUserMessage['uiEvent']): AuthorUserMessage {
  return {
    id: `m_u_${++userSeq}`,
    role: 'user',
    text,
    at: '2026-01-01T00:00:00.000Z',
    ...(uiEvent !== undefined ? { uiEvent } : {}),
  };
}

/** Mounts the real AppShell with the panel as its dock (the same tree App.tsx builds). */
function mount(chat: AuthorChat): HTMLDivElement {
  mocks.chat = chat;
  return render(
    <AppShell dock={<AuthorPanel />}>
      <p>screen</p>
    </AppShell>
  );
}

const panel = (c: HTMLElement) => c.querySelector('.author-panel') as HTMLElement;
const aside = (c: HTMLElement) => c.querySelector('aside#app-dock');
const body = (c: HTMLElement) => c.querySelector('.author-body') as HTMLElement;
const input = (c: HTMLElement) => c.querySelector<HTMLTextAreaElement>('.author-input')!;
const send = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('.author-send');
const suggestions = (c: HTMLElement) => [...c.querySelectorAll<HTMLButtonElement>('.author-suggestion')];

function key(el: Element, k: string, init: KeyboardEventInit = {}) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  });
}

function typeInto(el: HTMLTextAreaElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  installMemoryStorage();
  stubWide();
  window.localStorage.setItem(DOCK_OPEN_KEY, '1');
  window.location.hash = '#/';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AuthorPanel blank slate', () => {
  it('shows the empty state with the three create-focus suggestions', () => {
    const c = mount(chatWith());
    expect(body(c).getAttribute('aria-live')).toBe('polite');
    expect(c.querySelector('.author-empty-title')?.textContent).toBe('What should we build?');
    expect(suggestions(c).map((b) => b.textContent)).toEqual([
      'Create an agent that triages new GitHub issues and labels them',
      'Create an agent that answers questions from our docs',
      'Create an agent that summarises my inbox every morning',
    ]);
    expect(c.querySelector('.author-focus-chip--create')?.textContent).toBe('New agent');
  });

  it('shows edit-focus suggestions and an "Editing:" chip that clears to create', () => {
    const chat = chatWith({ focus: { mode: 'edit', agentId: 'support-triage' } });
    const c = mount(chat);
    expect(c.querySelector('.author-focus-chip strong')?.textContent).toBe('support-triage');
    expect(suggestions(c).map((b) => b.textContent)).toEqual([
      'What does this agent do?',
      'Add a guardrail that keeps personal data out of replies',
      'Why did the last run fail?',
    ]);
    const clear = c.querySelector<HTMLButtonElement>('.author-focus-clear')!;
    act(() => clear.click());
    expect(chat.setFocus).toHaveBeenCalledWith({ mode: 'create' });
  });

  it('clicking a suggestion sends its text', () => {
    const chat = chatWith();
    const c = mount(chat);
    act(() => suggestions(c)[0]!.click());
    expect(chat.send).toHaveBeenCalledWith('Create an agent that triages new GitHub issues and labels them');
  });
});

describe('AuthorPanel conversation', () => {
  it('renders user bubbles, event lines and assistant text', () => {
    const messages: AuthorMessage[] = [
      user('Build me a triage agent'),
      assistant([{ type: 'text', text: 'Here is a draft.' }], 'stop'),
      user('', { kind: 'save', proposalId: 'tc_9', agentId: 'triage', version: 3 }),
      user('', { kind: 'secret', toolCallId: 'tc_s', name: 'JIRA_TOKEN', outcome: 'saved' }),
      user('', { kind: 'secret', toolCallId: 'tc_d', name: 'SLACK_TOKEN', outcome: 'declined' }),
    ];
    const c = mount(chatWith({ messages }));
    expect(c.querySelector('.author-msg--user .author-bubble')?.textContent).toBe('Build me a triage agent');
    expect(c.querySelector('.author-text')?.textContent).toBe('Here is a draft.');
    const events = [...c.querySelectorAll('.author-event')].map((e) => e.textContent);
    expect(events).toEqual([
      'You applied the proposal · saved as version 3',
      'You saved JIRA_TOKEN',
      'You skipped SLACK_TOKEN',
    ]);
  });

  it('streams: text part, a busy activity line per read tool, Stop instead of Send', () => {
    const chat = chatWith({
      active: {
        requestId: 'r1',
        lastSeq: 3,
        assistant: assistant([
          { type: 'text', text: 'Let me look.' },
          tool({ name: 'getCurrentSpec', state: 'pending' }),
        ]),
      },
    });
    const c = mount(chat);
    expect(c.querySelector('.author-text')?.textContent).toBe('Let me look.');
    const line = c.querySelector('.author-activity');
    expect(line?.getAttribute('data-state')).toBe('busy');
    expect(line?.textContent).toBe('Reading the agent…');
    expect(c.querySelector('.author-stop')).not.toBeNull();
    expect(send(c)).toBeNull();
    act(() => c.querySelector<HTMLButtonElement>('.author-stop')!.click());
    expect(chat.stop).toHaveBeenCalled();
  });

  it('renders nothing for a draft-review bounce and a generic line for an unknown tool', () => {
    const c = mount(
      chatWith({
        messages: [
          assistant([
            tool({ name: 'proposeAgent', state: 'done', output: { ok: false, code: 'DRAFT_REVIEW', error: 'x', userMessage: 'x' } }),
            tool({ toolCallId: 'tc_2', name: 'mcp__jira__comment', state: 'done' }),
            tool({ toolCallId: 'tc_3', name: 'mcp__jira__comment', state: 'error' }),
          ]),
        ],
      })
    );
    const lines = [...c.querySelectorAll('.author-activity')];
    expect(lines).toHaveLength(2);
    expect(lines[0]!.textContent).toBe('Done');
    expect(lines[1]!.textContent).toBe('A step failed');
    expect(lines[1]!.getAttribute('data-state')).toBe('failed');
  });

  it('shows the exact end-of-turn note for max-steps, stopped and tool_input_cap only', () => {
    for (const [reason, note] of [
      ['max-steps', 'The Author stopped after 12 steps. Send a message to let it continue.'],
      ['stopped', 'Stopped.'],
      ['tool_input_cap', 'The Author stopped because a step kept failing. Try rephrasing your request.'],
    ] as const) {
      const c = mount(chatWith({ messages: [assistant([{ type: 'text', text: 'x' }], reason)] }));
      const el = c.querySelector('.author-turn-note');
      expect(el?.getAttribute('data-reason')).toBe(reason);
      expect(el?.textContent).toBe(note);
    }
    for (const reason of ['stop', 'error', 'aborted']) {
      const c = mount(chatWith({ messages: [assistant([{ type: 'text', text: 'x' }], reason)] }));
      expect(c.querySelector('.author-turn-note'), `no note for ${reason}`).toBeNull();
    }
  });
});

describe('AuthorPanel header', () => {
  it('shows Reconnecting…/Offline only in those states and disables send with the reason', () => {
    let c = mount(chatWith({ connection: 'reconnecting' }));
    const conn = c.querySelector('.author-conn');
    expect(conn?.getAttribute('data-state')).toBe('reconnecting');
    expect(conn?.textContent).toBe('Reconnecting…');

    typeInto(input(c), 'hello');
    expect(send(c)?.disabled).toBe(true);
    expect(send(c)?.getAttribute('title')).toBe('Reconnecting to Studio…');

    c = mount(chatWith({ connection: 'closed' }));
    expect(c.querySelector('.author-conn')?.textContent).toBe('Offline');
    expect(c.querySelector('.author-conn')?.getAttribute('data-state')).toBe('closed');

    c = mount(chatWith({ connection: 'open' }));
    expect(c.querySelector('.author-conn')).toBeNull();
  });

  it('disables send with "Type a message first" when empty and the setup reason without a key', () => {
    let c = mount(chatWith());
    expect(send(c)?.disabled).toBe(true);
    expect(send(c)?.getAttribute('title')).toBe('Type a message first');

    c = mount(chatWith({ setup: { ready: false, missingKeyFor: 'anthropic' } }));
    typeInto(input(c), 'hello');
    expect(send(c)?.disabled).toBe(true);
    expect(send(c)?.getAttribute('title')).toBe('Add an API key in Settings first');
  });

  it('New chat calls newChat and is disabled while a save runs', () => {
    let chat = chatWith();
    let c = mount(chat);
    const newBtn = [...c.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.getAttribute('aria-label') === 'New chat'
    )!;
    act(() => newBtn.click());
    expect(chat.newChat).toHaveBeenCalled();

    chat = chatWith({ saving: { proposalId: 'tc_9' } });
    c = mount(chat);
    const saving = [...c.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.getAttribute('aria-label') === 'New chat'
    )!;
    expect(saving.disabled).toBe(true);
    expect(saving.getAttribute('title')).toBe('Wait for the save to finish');
  });
});

describe('AuthorPanel composer', () => {
  it('Enter sends and clears; Shift+Enter does not send', () => {
    const chat = chatWith();
    const c = mount(chat);
    typeInto(input(c), 'Build a triage agent');
    key(input(c), 'Enter', { shiftKey: true });
    expect(chat.send).not.toHaveBeenCalled();
    key(input(c), 'Enter');
    expect(chat.send).toHaveBeenCalledWith('Build a triage agent');
    expect(input(c).value).toBe('');
  });

  it('refills the composer from restoreDraft', () => {
    const c = mount(chatWith({ restoreDraft: 'the refused message' }));
    expect(input(c).value).toBe('the refused message');
  });

  it('shows a dismissible error strip', () => {
    const chat = chatWith({ error: { message: "You're offline. Your message wasn't sent." } });
    const c = mount(chat);
    const strip = c.querySelector('.author-error');
    expect(strip?.getAttribute('role')).toBe('alert');
    expect(strip?.textContent).toContain("You're offline. Your message wasn't sent.");
    const dismiss = [...strip!.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Dismiss')!;
    act(() => dismiss.click());
    expect(chat.dismissError).toHaveBeenCalled();
  });
});

describe('AuthorPanel keyboard and navigation', () => {
  it('Escape stops a streaming reply; Escape again closes the panel', () => {
    const chat = chatWith({
      active: { requestId: 'r1', lastSeq: 1, assistant: assistant([{ type: 'text', text: 'hi' }]) },
    });
    const c = mount(chat);
    key(input(c), 'Escape');
    expect(chat.stop).toHaveBeenCalled();
    expect(aside(c)).not.toBeNull(); // still open

    mocks.chat = chatWith();
    rerender(
      <AppShell dock={<AuthorPanel />}>
        <p>screen</p>
      </AppShell>
    );
    key(c.querySelector('.author-input')!, 'Escape');
    expect(aside(c)).toBeNull();
    expect(window.localStorage.getItem(DOCK_OPEN_KEY)).toBe('0');
  });

  it('navigates when a live openPage result arrives', () => {
    mount(chatWith());
    act(() => fireOpenPage('/agents/support-triage/canvas'));
    expect(window.location.hash).toBe('#/agents/support-triage/canvas');
  });
});

describe('AuthorPanel accessibility', () => {
  it('gives every icon-only button an aria-label and the log aria-live', () => {
    const c = mount(chatWith({ messages: [assistant([{ type: 'text', text: 'hi' }])] }));
    const iconOnly = [...panel(c).querySelectorAll('button')].filter((b) => b.textContent?.trim() === '');
    expect(iconOnly.length).toBeGreaterThan(0);
    for (const b of iconOnly) {
      expect(b.getAttribute('aria-label'), `icon button missing aria-label: ${b.className}`).toBeTruthy();
    }
    expect(body(c).getAttribute('role')).toBe('log');
    expect(body(c).getAttribute('aria-live')).toBe('polite');
    expect(panel(c).getAttribute('aria-label')).toBe('Agent Author');
  });
});
