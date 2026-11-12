import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ScreenHeader's live run pill reads the app state; no provider in this test.
vi.mock('../../../state/AppState', () => ({ useAppState: () => ({ runStatus: null }) }));

const api = vi.hoisted(() => ({
  listInbox: vi.fn(),
  inboxCount: vi.fn(),
  approve: vi.fn(),
  answer: vi.fn(),
  dismissAlert: vi.fn(),
  addAlertToDataset: vi.fn(),
  subscribeEvents: vi.fn(() => () => {}),
}));
vi.mock('../../../runtime/runtimeClient', () => ({ runtimeClient: api }));

import type { InboxItem } from '../../../../shared/wireTypes';
import { InboxScreen } from '../InboxScreen';
import { render } from '../../../ui/__tests__/render';
import { ToastProvider } from '../../../ui/Toast';

const base = {
  agentId: 'support-bot',
  agentName: 'Support bot',
  workspaceId: 'ws',
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

const draft = (): InboxItem =>
  ({
    ...base,
    id: 'draft:support-bot:d1',
    kind: 'draft',
    draftId: 'd1',
    origin: 'author',
    gated: false,
    title: 'Pending change',
    detail: 'Tighten the refund policy.',
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

function mount() {
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
  api.listInbox.mockReset().mockResolvedValue([]);
  api.inboxCount.mockReset().mockResolvedValue({ count: 0 });
  api.approve.mockReset().mockResolvedValue({});
  api.answer.mockReset().mockResolvedValue({});
  api.dismissAlert.mockReset().mockResolvedValue(undefined);
  api.addAlertToDataset.mockReset().mockResolvedValue({ dataset: 'support-bot-regressions', exampleId: 'ex1' });
  api.subscribeEvents.mockClear();
});

describe('InboxScreen', () => {
  it('shows the empty state when nothing waits', async () => {
    const container = mount();
    await settle();
    expect(container.textContent).toContain('Nothing needs you');
    expect(container.textContent).toContain('Approvals, questions and suggested changes from your agents show up here.');
  });

  it('groups rows in contract order and hides empty groups', async () => {
    api.listInbox.mockResolvedValue([alert(), suggestion(), draft(), question(), approval()]);
    const container = mount();
    await settle();
    const titles = [...container.querySelectorAll('.inbox-group-title')].map((h) => h.textContent?.trim());
    expect(titles).toEqual(['Approvals 1', 'Questions 1', 'Drafts 1', 'Suggestions 1', 'Alerts 1']);
    const kinds = [...container.querySelectorAll('.inbox-row')].map((row) => row.getAttribute('data-kind'));
    expect(kinds).toEqual(['approval', 'question', 'draft', 'suggestion', 'alert']);
  });

  it('approves a tool call and removes the row', async () => {
    api.listInbox.mockResolvedValue([approval()]);
    const container = mount();
    await settle();
    await act(async () => button(container, 'Approve').click());
    await settle();
    expect(api.approve).toHaveBeenCalledWith('support-bot', 'a1', true);
    expect(container.querySelector('.inbox-row')).toBeNull();
    expect(container.textContent).toContain('Nothing needs you');
  });

  it('denies a tool call', async () => {
    api.listInbox.mockResolvedValue([approval()]);
    const container = mount();
    await settle();
    await act(async () => button(container, 'Deny').click());
    await settle();
    expect(api.approve).toHaveBeenCalledWith('support-bot', 'a1', false);
  });

  it('sends a question option as the answer', async () => {
    api.listInbox.mockResolvedValue([question()]);
    const container = mount();
    await settle();
    await act(async () => button(container, 'us-east').click());
    await settle();
    expect(api.answer).toHaveBeenCalledWith('support-bot', 'q1', 'us-east');
  });

  it('sends free-text question answers', async () => {
    api.listInbox.mockResolvedValue([question({ options: [], allowFreeText: true })]);
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

  it('dismisses an alert by its alertId', async () => {
    api.listInbox.mockResolvedValue([alert()]);
    const container = mount();
    await settle();
    await act(async () => button(container, 'Dismiss').click());
    await settle();
    expect(api.dismissAlert).toHaveBeenCalledWith('al1');
    expect(container.querySelector('.inbox-row')).toBeNull();
  });

  it('adds a low-rating alert’s trace to the regressions dataset (R04b)', async () => {
    api.listInbox.mockResolvedValue([
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

  it('does not offer the dataset action on other alert kinds', async () => {
    api.listInbox.mockResolvedValue([alert()]);
    const container = mount();
    await settle();
    expect(button(container, 'Add to dataset support-bot-regressions')).toBeUndefined();
  });

  it('links draft, suggestion and alert rows to their screens', async () => {
    api.listInbox.mockResolvedValue([draft(), suggestion(), alert()]);
    const container = mount();
    await settle();
    const hrefs = [...container.querySelectorAll('.inbox-row-actions a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual([
      '#/agents/support-bot/suggestions',
      '#/agents/support-bot/suggestions',
      '#/agents/support-bot/overview',
    ]);
  });

  it('keeps the row and toasts when an action fails', async () => {
    api.listInbox.mockResolvedValue([approval()]);
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
      api.listInbox.mockResolvedValue([
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

  it('refetches the list on every inbox.count event', async () => {
    api.listInbox.mockResolvedValue([]);
    mount();
    await settle();
    expect(api.listInbox).toHaveBeenCalledTimes(1);
    const onEvent = (api.subscribeEvents.mock.calls[0] as unknown[])[0] as (event: { type: string }) => void;
    await act(async () => onEvent({ type: 'inbox.count' }));
    await settle();
    expect(api.listInbox).toHaveBeenCalledTimes(2);
  });

  it('shows the error state with a retry', async () => {
    api.listInbox.mockRejectedValueOnce(new Error('boom'));
    const container = mount();
    await settle();
    expect(container.textContent).toContain("Couldn't load the inbox");
    expect(container.textContent).toContain('boom');
    await act(async () => button(container, 'Retry').click());
    await settle();
    expect(container.textContent).toContain('Nothing needs you');
  });
});
