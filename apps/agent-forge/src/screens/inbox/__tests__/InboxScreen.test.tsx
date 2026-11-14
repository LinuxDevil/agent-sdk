import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ScreenHeader's live run pill reads the app state; no provider in this test.
vi.mock('../../../state/AppState', () => ({ useAppState: () => ({ runStatus: null }) }));

const api = vi.hoisted(() => {
  const self: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const name of [
    'listInbox',
    'listAllInbox',
    'inboxCount',
    'allInboxCount',
    'approve',
    'answer',
    'dismissAlert',
    'addAlertToDataset',
    'suggestFromTrace',
  ]) {
    self[name] = vi.fn();
  }
  self.subscribeEvents = vi.fn<any[], unknown>(() => () => {});
  self.subscribeAllEvents = vi.fn<any[], unknown>(() => () => {});
  // Every workspace-pinned call lands back on the same mock surface; the
  // tests assert the id through `forWorkspace`'s own call list.
  self.forWorkspace = vi.fn<any[], unknown>(() => self);
  return self;
});
vi.mock('../../../runtime/runtimeClient', () => ({ runtimeClient: api }));

// The all-scope rows resolve workspace chips through the provider; these
// tests pin two known workspaces.
vi.mock('../../../workspace/WorkspacesProvider', () => ({
  useWorkspacesMaybe: () => ({
    list: [
      { id: 'ws-a1b2c3', name: 'Alpha', root: '/a', addedAt: '', lastOpenedAt: '', isLaunch: true, available: true, agentCount: 1, observeProject: 'alpha-app' },
      { id: 'ws-b2c3d4', name: 'Beta', root: '/b', addedAt: '', lastOpenedAt: '', isLaunch: false, available: true, agentCount: 1, observeProject: 'beta-app' },
    ],
    launchId: 'ws-a1b2c3',
    activeId: 'ws-a1b2c3',
    error: undefined,
    refresh: async () => {},
  }),
  useWorkspaces: () => {
    throw new Error('unused');
  },
}));

import type { InboxItem } from '../../../../shared/wireTypes';
import { InboxScreen } from '../InboxScreen';
import { render } from '../../../ui/__tests__/render';
import { ToastProvider } from '../../../ui/Toast';

const base = {
  agentId: 'support-bot',
  agentName: 'Support bot',
  workspaceId: 'ws-a1b2c3',
  detail: null,
  at: new Date(Date.now() - 3 * 60_000).toISOString(),
};

const approval = (over: Partial<InboxItem> = {}): InboxItem => ({
  ...base,
  id: 'approval:support-bot:a1',
  kind: 'approval',
  approvalId: 'a1',
  toolName: 'github_create_issue',
  args: { title: 'Fix the bug' },
  title: 'Approve github_create_issue?',
  detail: '{"title":"Fix the bug"}',
  expiresAt: new Date(Date.now() + 4 * 60_000 + 12_000).toISOString(),
  ...over,
} as InboxItem);

const question = (over: Partial<InboxItem> = {}): InboxItem => ({
  ...base,
  id: 'question:support-bot:q1',
  kind: 'question',
  approvalId: 'q1',
  question: 'Which region?',
  title: 'Which region?',
  options: ['us-east', 'eu-west'],
  allowFreeText: true,
  expiresAt: null,
  ...over,
} as InboxItem);

const draft = (over: Partial<InboxItem> = {}): InboxItem =>
  ({
    ...base,
    id: 'draft:support-bot:d1',
    kind: 'draft',
    draftId: 'd1',
    origin: 'author',
    gated: false,
    title: 'Pending change',
    detail: 'Tighten the refund policy.',
    ...over,
  }) as InboxItem;

const alert = (over: Partial<InboxItem> = {}): InboxItem =>
  ({
    ...base,
    id: 'alert:support-bot:al1',
    kind: 'alert',
    alertId: 'al1',
    alertKind: 'auto_disabled',
    payload: {},
    title: 'Auto-approval disabled',
    detail: '5 failures in a row',
    ...over,
  }) as InboxItem;

const suggestion = (): InboxItem =>
  ({
    ...base,
    id: 'suggestion:support-bot:s1',
    kind: 'suggestion',
    suggestionId: 's1',
    confidence: 'high',
    title: 'Prompt suggestion',
    detail: 'Saves ~200 tokens',
  }) as InboxItem;

function mount(hash = '#/inbox') {
  window.location.hash = hash;
  return render(
    <ToastProvider>
      <InboxScreen />
    </ToastProvider>,
  );
}

async function settle() {
  await act(async () => {});
}

const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement;

beforeEach(() => {
  for (const fn of Object.values(api)) {
    if (typeof fn === 'function' && 'mockReset' in fn) (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  api.listAllInbox.mockResolvedValue([]);
  api.listInbox.mockResolvedValue([]);
  api.inboxCount.mockResolvedValue({ count: 0 });
  api.allInboxCount.mockResolvedValue(0);
  api.approve.mockResolvedValue({});
  api.answer.mockResolvedValue({});
  api.dismissAlert.mockResolvedValue(undefined);
  api.addAlertToDataset.mockResolvedValue({ dataset: 'support-bot-regressions', exampleId: 'ex1' });
  api.suggestFromTrace.mockResolvedValue({ suggestionId: 'sg-1' });
  api.subscribeEvents.mockImplementation(() => () => {});
  api.subscribeAllEvents.mockImplementation(() => () => {});
  api.forWorkspace.mockImplementation(() => api);
  window.location.hash = '';
});

describe('InboxScreen (all workspaces, #/inbox)', () => {
  it('shows the empty state when nothing waits', async () => {
    const container = mount();
    await settle();
    expect(container.textContent).toContain('Nothing needs you');
    expect(container.textContent).toContain('Approvals, questions and suggested changes from your agents show up here.');
  });

  it('uses the aggregate fetcher and describes every workspace (W09b)', async () => {
    const container = mount();
    await settle();
    expect(api.listAllInbox).toHaveBeenCalledTimes(1);
    expect(api.listInbox).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Approvals, questions and changes waiting on you in every workspace.');
  });

  it('groups rows in contract order and hides empty groups', async () => {
    api.listAllInbox.mockResolvedValue([alert(), suggestion(), draft(), question(), approval()]);
    const container = mount();
    await settle();
    const titles = [...container.querySelectorAll('.inbox-group-title')].map((h) => h.textContent?.trim());
    expect(titles).toEqual(['Approvals 1', 'Questions 1', 'Drafts 1', 'Suggestions 1', 'Alerts 1']);
    const kinds = [...container.querySelectorAll('.inbox-row')].map((row) => row.getAttribute('data-kind'));
    expect(kinds).toEqual(['approval', 'question', 'draft', 'suggestion', 'alert']);
  });

  it('shows a workspace chip before the agent name on every row (W09b)', async () => {
    api.listAllInbox.mockResolvedValue([
      approval(),
      draft({ id: 'draft:support-bot:d2', workspaceId: 'ws-b2c3d4', agentId: 'other-bot', agentName: 'Other bot' }),
    ]);
    const container = mount();
    await settle();
    const chips = [...container.querySelectorAll('.inbox-row-workspace')].map((c) => c.textContent);
    expect(chips).toEqual(['Alpha', 'Beta']);
    // The chip precedes the agent name inside the row's meta line.
    const meta = container.querySelector('.inbox-row-meta')!;
    expect(meta.innerHTML.indexOf('inbox-row-workspace')).toBeLessThan(meta.innerHTML.indexOf('Support bot'));
  });

  it('keys rows by <workspaceId>/<id> so same-id items in two workspaces both render (W09b)', async () => {
    api.listAllInbox.mockResolvedValue([
      draft({ id: 'draft:same:d1', workspaceId: 'ws-a1b2c3' }),
      draft({ id: 'draft:same:d1', workspaceId: 'ws-b2c3d4', agentId: 'other-bot', agentName: 'Other bot' }),
    ]);
    const container = mount();
    await settle();
    expect(container.querySelectorAll('.inbox-row')).toHaveLength(2);
  });

  it('approves through the row’s workspace and removes it', async () => {
    api.listAllInbox.mockResolvedValue([approval({ workspaceId: 'ws-b2c3d4' })]);
    const container = mount();
    await settle();
    await act(async () => button(container, 'Approve').click());
    await settle();
    expect(api.forWorkspace).toHaveBeenCalledWith('ws-b2c3d4');
    expect(api.approve).toHaveBeenCalledWith('support-bot', 'a1', true);
    expect(container.querySelector('.inbox-row')).toBeNull();
    expect(container.textContent).toContain('Nothing needs you');
  });

  it('denies a tool call', async () => {
    api.listAllInbox.mockResolvedValue([approval()]);
    const container = mount();
    await settle();
    await act(async () => button(container, 'Deny').click());
    await settle();
    expect(api.approve).toHaveBeenCalledWith('support-bot', 'a1', false);
  });

  it('sends a question option as the answer', async () => {
    api.listAllInbox.mockResolvedValue([question()]);
    const container = mount();
    await settle();
    await act(async () => button(container, 'us-east').click());
    await settle();
    expect(api.answer).toHaveBeenCalledWith('support-bot', 'q1', 'us-east');
  });

  it('sends free-text question answers', async () => {
    api.listAllInbox.mockResolvedValue([question({ options: [], allowFreeText: true })]);
    const container = mount();
    await settle();
    const input = container.querySelector('.inbox-answer') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'ap-south');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button(container, 'Send').click());
    await settle();
    expect(api.answer).toHaveBeenCalledWith('support-bot', 'q1', 'ap-south');
  });

  it('dismisses an alert through its workspace by alertId', async () => {
    api.listAllInbox.mockResolvedValue([alert({ workspaceId: 'ws-b2c3d4' })]);
    const container = mount();
    await settle();
    await act(async () => button(container, 'Dismiss').click());
    await settle();
    expect(api.forWorkspace).toHaveBeenCalledWith('ws-b2c3d4');
    expect(api.dismissAlert).toHaveBeenCalledWith('al1');
    expect(container.querySelector('.inbox-row')).toBeNull();
  });

  it('adds a low-rating alert’s trace to the regressions dataset (R04b)', async () => {
    api.listAllInbox.mockResolvedValue([
      alert({ alertKind: 'low_rating', payload: { traceId: 't-1' }, title: 'Run rated 2' }),
    ]);
    const container = mount();
    await settle();

    const add = button(container, 'Add to dataset support-bot-regressions');
    expect(add).toBeDefined();
    await act(async () => add.click());
    await settle();

    expect(api.addAlertToDataset).toHaveBeenCalledWith('support-bot', 'al1');
    expect(container.textContent).toContain('Added to support-bot-regressions');
    // The row stays - the alert is dismissed separately.
    expect(container.querySelector('.inbox-row')).not.toBeNull();
  });

  it('"Suggest a fix" pins the request and the link to the row’s workspace (R06, W09b)', async () => {
    api.listAllInbox.mockResolvedValue([
      alert({ workspaceId: 'ws-b2c3d4', alertKind: 'low_rating', payload: { traceId: 't-1' }, title: 'Run rated 2' }),
    ]);
    const container = mount();
    await settle();

    const suggest = button(container, 'Suggest a fix');
    expect(suggest).toBeDefined();
    await act(async () => suggest.click());
    await settle();

    expect(api.forWorkspace).toHaveBeenCalledWith('ws-b2c3d4');
    expect(api.suggestFromTrace).toHaveBeenCalledWith('support-bot', 't-1');
    expect(window.location.hash).toBe('#/w/ws-b2c3d4/agents/support-bot/suggestions?suggesting=sg-1');
  });

  it('does not offer "Suggest a fix" without a traceId in the alert payload', async () => {
    api.listAllInbox.mockResolvedValue([
      alert({ alertKind: 'low_rating', payload: {}, title: 'Run rated 2' }),
    ]);
    const container = mount();
    await settle();
    expect(button(container, 'Suggest a fix')).toBeUndefined();
  });

  it('does not offer the dataset action on other alert kinds', async () => {
    api.listAllInbox.mockResolvedValue([alert()]);
    const container = mount();
    await settle();
    expect(button(container, 'Add to dataset support-bot-regressions')).toBeUndefined();
  });

  it('links rows to agent screens inside their own workspace (W09b)', async () => {
    api.listAllInbox.mockResolvedValue([
      draft(),
      suggestion(),
      alert(),
      alert({ id: 'alert:other-bot:al2', workspaceId: 'ws-b2c3d4', agentId: 'other-bot', agentName: 'Other bot' }),
    ]);
    const container = mount();
    await settle();
    const hrefs = [...container.querySelectorAll('.inbox-row-actions a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual([
      '#/w/ws-a1b2c3/agents/support-bot/suggestions',
      '#/w/ws-a1b2c3/agents/support-bot/suggestions',
      '#/w/ws-a1b2c3/agents/support-bot/overview',
      '#/w/ws-b2c3d4/agents/other-bot/overview',
    ]);
    // The agent-name link in the meta line is workspace-scoped too.
    const agentLink = container.querySelector('.inbox-row-meta a')!;
    expect(agentLink.getAttribute('href')).toBe('#/w/ws-a1b2c3/agents/support-bot/canvas');
  });

  it('keeps the row and toasts when an action fails', async () => {
    api.listAllInbox.mockResolvedValue([approval()]);
    api.approve.mockRejectedValue(new Error('run already finished'));
    const container = mount();
    await settle();
    await act(async () => button(container, 'Approve').click());
    await settle();
    expect(container.querySelector('.inbox-row')).not.toBeNull();
    expect(container.textContent).toContain('run already finished');
  });

  it('shows Expired with disabled actions past the deadline', async () => {
    vi.useFakeTimers();
    try {
      api.listAllInbox.mockResolvedValue([
        approval({ expiresAt: new Date(Date.now() + 30_000).toISOString() }),
      ]);
      const container = mount();
      await act(async () => {});
      expect(container.textContent).toContain('Expires in 0:30');
      await act(async () => {
        vi.advanceTimersByTime(31_000);
      });
      expect(container.textContent).toContain('Expired');
      expect(button(container, 'Approve').disabled).toBe(true);
      expect(button(container, 'Approve').title).toBe('This request expired');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refetches the list on every aggregate inbox.count frame', async () => {
    api.listAllInbox.mockResolvedValue([]);
    mount();
    await settle();
    expect(api.listAllInbox).toHaveBeenCalledTimes(1);
    expect(api.subscribeAllEvents).toHaveBeenCalledTimes(1);
    const onFrame = api.subscribeAllEvents.mock.calls[0][0] as (frame: { type: string }) => void;
    await act(async () => onFrame({ type: 'inbox.count' }));
    await settle();
    expect(api.listAllInbox).toHaveBeenCalledTimes(2);
  });

  it('shows the error state with a retry', async () => {
    api.listAllInbox.mockRejectedValueOnce(new Error('boom'));
    const container = mount();
    await settle();
    expect(container.textContent).toContain("Couldn't load the inbox");
    expect(container.textContent).toContain('boom');
    await act(async () => button(container, 'Retry').click());
    await settle();
    expect(container.textContent).toContain('Nothing needs you');
  });
});

describe('InboxScreen (one workspace, #/w/<ws>/inbox)', () => {
  it('fetches that workspace’s inbox, shows no chips, and names it in the header (W09b)', async () => {
    api.listInbox.mockResolvedValue([approval({ workspaceId: 'ws-b2c3d4' })]);
    const container = mount('#/w/ws-b2c3d4/inbox');
    await settle();
    expect(api.forWorkspace).toHaveBeenCalledWith('ws-b2c3d4');
    expect(api.listInbox).toHaveBeenCalledTimes(1);
    expect(api.listAllInbox).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Approvals, questions and changes waiting on you in Beta.');
    expect(container.querySelector('.inbox-row-workspace')).toBeNull();
    // Scoped view keeps the per-workspace /events subscription.
    expect(api.subscribeEvents).toHaveBeenCalledTimes(1);
    expect(api.subscribeAllEvents).not.toHaveBeenCalled();
  });

  it('still pins row actions to the item’s workspace', async () => {
    api.listInbox.mockResolvedValue([approval({ workspaceId: 'ws-b2c3d4' })]);
    const container = mount('#/w/ws-b2c3d4/inbox');
    await settle();
    await act(async () => button(container, 'Approve').click());
    await settle();
    expect(api.forWorkspace).toHaveBeenCalledWith('ws-b2c3d4');
    expect(api.approve).toHaveBeenCalledWith('support-bot', 'a1', true);
  });
});
