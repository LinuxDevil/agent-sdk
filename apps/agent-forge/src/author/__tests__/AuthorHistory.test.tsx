import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';

const appState = vi.hoisted(() => ({ connected: true, agents: [] as { id: string; name: string }[] }));
vi.mock('../../state/AppState', () => ({ useAppState: () => appState }));

const mocks = vi.hoisted(() => ({ chat: null as unknown as import('../AuthorChatContext').AuthorChat }));
vi.mock('../AuthorChatContext', () => ({ useAuthorChat: () => mocks.chat }));

vi.mock('../../runtime/runtimeClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../runtime/runtimeClient')>();
  return {
    ...actual,
    runtimeClient: {
      listAuthorSessions: vi.fn(),
      deleteAuthorSession: vi.fn(),
    },
  };
});

import { AppShell } from '../../shell/AppShell';
import { DOCK_OPEN_KEY } from '../../shell/dockState';
import { AuthorPanel } from '../AuthorPanel';
import { initialAuthorChatState, type AuthorChatState } from '../authorChatReducer';
import { render } from '../../ui/__tests__/render';
import { installMemoryStorage } from '../../ui/__tests__/memoryStorage';
import { ToastProvider } from '../../ui/Toast';
import { runtimeClient, RuntimeApiError } from '../../runtime/runtimeClient';
import type { AuthorChat } from '../AuthorChatContext';
import type { AuthorSessionSummary } from '../../../shared/authorWire';

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
    sessionId: 's1',
    title: 'Current chat',
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
    openSession: vi.fn().mockResolvedValue(undefined),
    setFocus: vi.fn(),
    apply: vi.fn(),
    enable: vi.fn(),
    submitSecret: vi.fn(),
    recheckSetup: vi.fn(),
    dismissError: vi.fn(),
  };
}

let seq = 0;
function SUMMARY(id: string, over: Partial<AuthorSessionSummary> = {}): AuthorSessionSummary {
  seq += 1;
  return {
    id,
    title: `Chat ${id}`,
    focus: { mode: 'create' },
    workspaceId: 'ws-1',
    updatedAt: new Date(Date.now() - seq * 60_000).toISOString(),
    messageCount: 2,
    createdAgentIds: [],
    ...over,
  };
}

/** Mounts the real AppShell with the panel as its dock (the same tree App.tsx builds). */
function mount(chat: AuthorChat): HTMLDivElement {
  mocks.chat = chat;
  return render(
    <ToastProvider>
      <AppShell dock={<AuthorPanel />}>
        <p>screen</p>
      </AppShell>
    </ToastProvider>
  );
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const historyBtn = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('.author-history-btn')!;
const historySection = (c: HTMLElement) => c.querySelector('.author-history');
const items = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('.author-history-item')];
const openBtn = (li: Element) => li.querySelector<HTMLButtonElement>('.author-history-open')!;
const deleteBtn = (li: Element) =>
  [...li.querySelectorAll<HTMLButtonElement>('button.icon-btn')].find((b) =>
    b.getAttribute('aria-label')?.startsWith('Delete chat')
  )!;
const dialog = () => document.querySelector<HTMLElement>('.dialog');

/** Opens the history view and waits for the (mocked) session fetch to settle. */
async function openHistory(c: HTMLElement): Promise<void> {
  act(() => historyBtn(c).click());
  await act(flush);
}

function key(el: Element, k: string, init: KeyboardEventInit = {}) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  });
}

beforeEach(() => {
  installMemoryStorage();
  stubWide();
  window.localStorage.setItem(DOCK_OPEN_KEY, '1');
  window.location.hash = '#/';
  appState.agents = [{ id: 'support-triage', name: 'Support Triage' }];
  vi.mocked(runtimeClient.listAuthorSessions).mockResolvedValue([]);
  vi.mocked(runtimeClient.deleteAuthorSession).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AuthorHistory list', () => {
  it('lists sessions newest first with title, focus, relative time and message count', async () => {
    const now = Date.now();
    vi.mocked(runtimeClient.listAuthorSessions).mockResolvedValue([
      SUMMARY('old', { title: 'Old chat', updatedAt: new Date(now - 3 * 3_600_000).toISOString() }),
      SUMMARY('new', {
        title: 'Fresh chat',
        focus: { mode: 'edit', agentId: 'support-triage' },
        updatedAt: new Date(now - 5 * 60_000).toISOString(),
        messageCount: 1,
        createdAgentIds: ['support-triage', 'missing-agent'],
      }),
      SUMMARY('mid', { title: 'Mid chat', updatedAt: new Date(now - 90 * 60_000).toISOString() }),
    ]);
    const c = mount(chatWith({ sessionId: 'none' }));
    await openHistory(c);

    const rows = items(c);
    expect(rows.map((r) => r.querySelector('.author-history-name')?.textContent)).toEqual([
      'Fresh chat',
      'Mid chat',
      'Old chat',
    ]);
    const meta = (r: Element) => r.querySelector('.author-history-meta')?.textContent;
    expect(meta(rows[0]!)).toBe('Editing Support Triage · 5m ago · 1 message · created Support Triage, missing-agent');
    expect(meta(rows[1]!)).toBe('New agent · 2h ago · 2 messages');
  });

  it('shows 4 skeleton rows while the list loads', async () => {
    let resolve: (v: AuthorSessionSummary[]) => void = () => {};
    vi.mocked(runtimeClient.listAuthorSessions).mockImplementation(
      () => new Promise((r) => (resolve = r))
    );
    const c = mount(chatWith());
    act(() => historyBtn(c).click());
    expect(c.querySelectorAll('.skeleton-row')).toHaveLength(4);
    await act(async () => {
      resolve([]);
      await flush();
    });
  });

  it('shows the empty copy when there are no earlier chats', async () => {
    const c = mount(chatWith());
    await openHistory(c);
    expect(c.querySelector('.empty-state-title')?.textContent).toBe('No earlier chats');
    expect(c.querySelector('.empty-state-hint')?.textContent).toBe(
      'Chats you have with the Author show up here.'
    );
  });

  it('shows the error note and reloads on Try again', async () => {
    vi.mocked(runtimeClient.listAuthorSessions).mockRejectedValueOnce(new Error('down'));
    const c = mount(chatWith());
    await openHistory(c);
    const note = c.querySelector('.error-note');
    expect(note?.getAttribute('role')).toBe('alert');
    expect(note?.textContent).toContain("Couldn't load your chats.");
    vi.mocked(runtimeClient.listAuthorSessions).mockResolvedValueOnce([SUMMARY('s2')]);
    const retry = [...c.querySelectorAll<HTMLButtonElement>('.error-note button')].find(
      (b) => b.textContent === 'Try again'
    )!;
    act(() => retry.click());
    await act(flush);
    expect(items(c)).toHaveLength(1);
  });
});

describe('AuthorHistory switching', () => {
  it('opens a session and closes history; the open chat cannot be reopened', async () => {
    const chat = chatWith({ sessionId: 's1' });
    vi.mocked(runtimeClient.listAuthorSessions).mockResolvedValue([
      SUMMARY('s1', { title: 'Current chat' }),
      SUMMARY('s2', { title: 'Other chat' }),
    ]);
    const c = mount(chat);
    await openHistory(c);

    const rows = items(c);
    expect(rows[0]!.getAttribute('data-current')).toBe('true');
    expect(rows[1]!.getAttribute('data-current')).toBe('false');
    expect(openBtn(rows[0]!).disabled).toBe(true);
    expect(openBtn(rows[0]!).getAttribute('title')).toBe('This chat is open');

    act(() => openBtn(rows[1]!).click());
    await act(flush);
    expect(chat.openSession).toHaveBeenCalledWith('s2');
    expect(historySection(c)).toBeNull();
    expect(c.querySelector('.author-body')).not.toBeNull();
  });

  it('the History button toggles the view with aria-pressed and Back to chat closes it', async () => {
    const c = mount(chatWith());
    await openHistory(c);
    expect(historyBtn(c).getAttribute('aria-pressed')).toBe('true');
    const back = [...c.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Back to chat'
    )!;
    act(() => back.click());
    expect(historySection(c)).toBeNull();
    expect(historyBtn(c).getAttribute('aria-pressed')).toBe('false');
  });

  it('Escape closes history but keeps the dock open; the composer is disabled with the reason', async () => {
    const c = mount(chatWith());
    await openHistory(c);
    const input = c.querySelector<HTMLTextAreaElement>('.author-input')!;
    expect(input.disabled).toBe(true);
    expect(input.getAttribute('title')).toBe('Close history to keep chatting');
    key(c.querySelector('.author-history')!, 'Escape');
    expect(historySection(c)).toBeNull();
    expect(c.querySelector('aside#app-dock')).not.toBeNull();
    expect(c.querySelector<HTMLTextAreaElement>('.author-input')!.disabled).toBe(false);
  });
});

describe('AuthorHistory delete', () => {
  async function mountWithSessions(chat: AuthorChat): Promise<HTMLElement> {
    vi.mocked(runtimeClient.listAuthorSessions).mockResolvedValue([
      SUMMARY('s1', { title: 'Current chat' }),
      SUMMARY('s2', { title: 'Other chat' }),
    ]);
    const c = mount(chat);
    await openHistory(c);
    return c;
  }

  it('asks before deleting, then removes the row and toasts', async () => {
    const chat = chatWith({ sessionId: 's1' });
    const c = await mountWithSessions(chat);
    act(() => deleteBtn(items(c)[1]!).click());
    await act(flush);
    expect(dialog()?.querySelector('.dialog-title')?.textContent).toBe('Delete this chat?');
    expect(dialog()?.querySelector('.dialog-description')?.textContent).toBe(
      '“Other chat” will be removed from History. Agents it created are kept.'
    );
    // Cancel keeps the row.
    const cancel = [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Cancel'
    )!;
    act(() => cancel.click());
    await act(flush);
    expect(items(c)).toHaveLength(2);
    expect(runtimeClient.deleteAuthorSession).not.toHaveBeenCalled();

    act(() => deleteBtn(items(c)[1]!).click());
    await act(flush);
    const confirm = [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Delete chat'
    )!;
    act(() => confirm.click());
    await act(flush);
    expect(runtimeClient.deleteAuthorSession).toHaveBeenCalledWith('s2');
    expect(items(c)).toHaveLength(1);
    expect(c.querySelector('.toast-message')?.textContent).toBe('Chat deleted');
    expect(chat.newChat).not.toHaveBeenCalled();
  });

  it('deleting the current chat starts a new chat', async () => {
    const chat = chatWith({ sessionId: 's1' });
    const c = await mountWithSessions(chat);
    act(() => deleteBtn(items(c)[0]!).click());
    await act(flush);
    const confirm = [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Delete chat'
    )!;
    act(() => confirm.click());
    await act(flush);
    expect(runtimeClient.deleteAuthorSession).toHaveBeenCalledWith('s1');
    expect(chat.newChat).toHaveBeenCalled();
  });

  it('a 409 refusal toasts "Stop the reply before deleting this chat."', async () => {
    vi.mocked(runtimeClient.deleteAuthorSession).mockRejectedValue(
      new RuntimeApiError('Stop the reply before deleting this chat.', 409, 'BUSY')
    );
    const chat = chatWith({ sessionId: 's1' });
    const c = await mountWithSessions(chat);
    act(() => deleteBtn(items(c)[1]!).click());
    await act(flush);
    const confirm = [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Delete chat'
    )!;
    act(() => confirm.click());
    await act(flush);
    expect(c.querySelector('.toast-message')?.textContent).toBe(
      'Stop the reply before deleting this chat.'
    );
    expect(items(c)).toHaveLength(2); // the row stays - it was not deleted
  });

  it('the delete icon carries an aria-label with the chat title', async () => {
    const c = await mountWithSessions(chatWith());
    expect(deleteBtn(items(c)[1]!).getAttribute('aria-label')).toBe('Delete chat “Other chat”');
  });
});

describe('AuthorHistory busy states', () => {
  it('disables open and delete with the save reason while a save runs', async () => {
    const chat = chatWith({ sessionId: 's0', saving: { proposalId: 'tc_1' } });
    vi.mocked(runtimeClient.listAuthorSessions).mockResolvedValue([SUMMARY('s1')]);
    const c = mount(chat);
    await openHistory(c);
    const row = items(c)[0]!;
    expect(openBtn(row).disabled).toBe(true);
    expect(openBtn(row).getAttribute('title')).toBe('Wait for the save to finish');
    expect(deleteBtn(row).disabled).toBe(true);
    expect(deleteBtn(row).getAttribute('title')).toBe('Wait for the save to finish');
  });

  it('disables open and delete with the streaming reason while a reply runs', async () => {
    const chat = chatWith({
      sessionId: 's0',
      active: {
        requestId: 'r1',
        lastSeq: 1,
        assistant: { id: 'a1', role: 'assistant', parts: [], at: '2026-01-01T00:00:00.000Z', requestId: 'r1' },
      },
    });
    vi.mocked(runtimeClient.listAuthorSessions).mockResolvedValue([SUMMARY('s1')]);
    const c = mount(chat);
    await openHistory(c);
    const row = items(c)[0]!;
    expect(openBtn(row).disabled).toBe(true);
    expect(openBtn(row).getAttribute('title')).toBe('Wait for the Author to finish replying');
    expect(deleteBtn(row).disabled).toBe(true);
    expect(deleteBtn(row).getAttribute('title')).toBe('Wait for the Author to finish replying');
  });
});
