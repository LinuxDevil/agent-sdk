import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InboxService, type InboxServiceDeps } from '../inboxService';
import { StudioEventBus } from '../../events/eventBus';
import { AlertStore } from '../alertStore';
import type { AgentRepo } from '../../storage/agentRepo';
import type { DraftStore } from '../../storage/draftStore';
import type { SuggestionStore } from '../../storage/suggestionStore';
import type { FileApprovalStore } from '../../approvalStore';
import type { RunManager } from '../../runRegistry';
import type { AgentRunStatusPayload, ChangeDraft, PromptSuggestion } from '../../../shared/wireTypes';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const WS = 'ws-test';

function statusPayload(over: Partial<AgentRunStatusPayload> = {}): AgentRunStatusPayload {
  return { agentId: 'a1', status: 'idle', updatedAt: '2026-01-01T00:00:00.000Z', ...over };
}

function pausedWith(pending: NonNullable<AgentRunStatusPayload['pendingApproval']>): AgentRunStatusPayload {
  return statusPayload({ status: 'paused', reason: 'awaiting_approval', pendingApproval: pending });
}

function draft(over: Partial<ChangeDraft> = {}): ChangeDraft {
  return {
    id: 'd1',
    agentId: 'a1',
    status: 'pending',
    origin: 'author',
    patch: { description: 'x' },
    reason: 'Tighten the prompt.',
    baseVersion: null,
    baseSpecHash: 'h',
    autoReview: null,
    classes: null,
    note: null,
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    respondedAt: null,
    ...over,
  };
}

function suggestion(over: Partial<PromptSuggestion> = {}): PromptSuggestion {
  return {
    kind: 'prompt_edit',
    id: 's1',
    agentId: 'a1',
    sourceTraceId: 't1',
    expectedPromptHash: 'p1',
    proposedPromptHash: 'p2',
    oldText: 'a',
    newText: 'b',
    confidence: 'high',
    optimizationClass: 'c',
    evidence: 'e',
    expectedSaving: 'saves a step',
    risk: 'low',
    validationPlan: [],
    status: 'open',
    createdAt: '2026-01-03T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:00.000Z',
    ...over,
  };
}

describe('InboxService', () => {
  let dir: string;
  let alerts: AlertStore;
  let events: StudioEventBus;
  let statuses: Map<string, AgentRunStatusPayload>;
  let drafts: Map<string, ChangeDraft | undefined>;
  let suggestions: Map<string, PromptSuggestion[]>;
  let agentNames: Map<string, string>;
  let peeks: Map<string, { pending: { expiresAt?: string }; snapshot: unknown } | null>;

  const statusOf = (id: string) => statuses.get(id) ?? statusPayload({ agentId: id });

  const deps = (): InboxServiceDeps => ({
    repo: {
      listIds: () => [...agentNames.keys()],
      readSpec: async (id: string) => ({ name: agentNames.get(id) ?? id }) as never,
    } as unknown as AgentRepo,
    runManager: {
      status: (id: string) => statusOf(id),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as RunManager,
    approvalStore: {
      peek: async (agentId: string, approvalId: string) => peeks.get(`${agentId}:${approvalId}`) ?? null,
    } as unknown as FileApprovalStore,
    drafts: { current: async (id: string) => drafts.get(id) } as unknown as DraftStore,
    suggestions: { list: async (id: string) => suggestions.get(id) ?? [] } as unknown as SuggestionStore,
    alerts,
    events,
    workspaceId: WS,
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-inbox-'));
    alerts = new AlertStore(path.join(dir, 'alerts.json'));
    events = new StudioEventBus();
    statuses = new Map();
    drafts = new Map();
    suggestions = new Map();
    agentNames = new Map([['a1', 'Agent One'], ['a2', 'Agent Two']]);
    peeks = new Map();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists one item per waiting thing with the contract ids, copy and agentName', async () => {
    statuses.set(
      'a1',
      pausedWith({
        approvalId: 'ap1',
        toolName: 'github_create_issue',
        args: { title: 'Bug' },
        createdAt: '2026-01-04T00:00:00.000Z',
        kind: 'tool',
        deadline: '2099-01-04T00:10:00.000Z',
      })
    );
    drafts.set('a1', draft());
    suggestions.set('a1', [suggestion(), suggestion({ id: 's2', status: 'applied' })]);
    const ownAlert = await alerts.add({ kind: 'auto_disabled', agentId: 'a2', workspaceId: WS, title: 'Auto-disabled', detail: '5 failures', payload: {} });
    await alerts.add({ kind: 'low_rating', agentId: 'a2', workspaceId: 'other-ws', title: 'Other ws', detail: null, payload: {} });

    const items = await new InboxService(deps()).list();
    // The approval's deadline sorts it first; the rest have no expiresAt
    // and order by `at` desc - the alert's real-time createdAt is newest.
    expect(items.map((item) => item.id)).toEqual([
      'approval:a1:ap1',
      `alert:a2:${ownAlert.id}`,
      'suggestion:a1:s1',
      'draft:a1:d1',
    ]);
    const [approval, alertItem, suggestionItem, draftItem] = items;
    expect(approval).toMatchObject({
      kind: 'approval',
      agentId: 'a1',
      workspaceId: WS,
      agentName: 'Agent One',
      title: 'Approve github_create_issue?',
      toolName: 'github_create_issue',
      expiresAt: '2099-01-04T00:10:00.000Z',
    });
    expect(draftItem).toMatchObject({ kind: 'draft', title: 'Pending change', detail: 'Tighten the prompt.', origin: 'author', gated: false });
    expect(suggestionItem).toMatchObject({ kind: 'suggestion', title: 'Prompt suggestion', detail: 'saves a step', confidence: 'high' });
    expect(alertItem).toMatchObject({ kind: 'alert', agentName: 'Agent Two', title: 'Auto-disabled', detail: '5 failures' });
    // The other workspace's alert and the applied suggestion are absent.
    expect(items).toHaveLength(4);
  });

  it('lists a paused ask_question as a question item with options and allowFreeText', async () => {
    statuses.set(
      'a1',
      pausedWith({
        approvalId: 'q1',
        toolName: 'ask_question',
        args: {},
        createdAt: '2026-01-04T00:00:00.000Z',
        kind: 'question',
        question: { text: 'Which repo?', options: ['api', 'web'], allowFreeText: true },
        deadline: '2099-01-04T00:05:00.000Z',
      })
    );
    const items = await new InboxService(deps()).list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'question:a1:q1',
      kind: 'question',
      title: 'Which repo?',
      detail: null,
      question: 'Which repo?',
      options: ['api', 'web'],
      allowFreeText: true,
      expiresAt: '2099-01-04T00:05:00.000Z',
    });
  });

  it('marks a draft gated when its classes name gated fields', async () => {
    drafts.set('a1', draft({ classes: { routine: ['description'], gated: ['permissions'] } }));
    const items = await new InboxService(deps()).list();
    expect(items[0]).toMatchObject({ kind: 'draft', gated: true });
  });

  it('sorts by expiresAt ascending (nulls last), then at descending', async () => {
    const pending = (approvalId: string, deadline: string, createdAt: string) =>
      pausedWith({ approvalId, toolName: 't', args: {}, createdAt, kind: 'tool', deadline });
    statuses.set('a1', pending('late', '2099-01-05T00:00:00.000Z', '2026-01-04T00:00:00.000Z'));
    statuses.set('a2', pending('soon', '2099-01-04T00:01:00.000Z', '2026-01-03T00:00:00.000Z'));
    drafts.set('a1', draft({ createdAt: '2026-01-06T00:00:00.000Z' }));

    const items = await new InboxService(deps()).list();
    // a2's approval has the soonest deadline; a1's approval is next; the
    // draft has no expiresAt so it sorts last despite the newest `at`.
    expect(items.map((item) => item.id)).toEqual(['approval:a2:soon', 'approval:a1:late', 'draft:a1:d1']);
  });

  it('takes expiresAt from the approval store record and skips pauses the store lost once past deadline', async () => {
    peeks.set('a1:ap1', { pending: { expiresAt: '2099-02-01T00:00:00.000Z' }, snapshot: {} });
    statuses.set(
      'a1',
      pausedWith({ approvalId: 'ap1', toolName: 't', args: {}, createdAt: '2026-01-04T00:00:00.000Z', kind: 'tool', deadline: '2099-01-04T00:10:00.000Z' })
    );
    // a3's pause has no store record and its deadline already passed - stale.
    agentNames.set('a3', 'Agent Three');
    statuses.set(
      'a3',
      pausedWith({ approvalId: 'old', toolName: 't', args: {}, createdAt: '2026-01-04T00:00:00.000Z', kind: 'tool', deadline: '2000-01-01T00:00:00.000Z' })
    );
    // a store record still held keeps a past-deadline pause listed.
    peeks.set('a2:held', { pending: { expiresAt: '2000-01-01T00:00:00.000Z' }, snapshot: {} });
    statuses.set(
      'a2',
      pausedWith({ approvalId: 'held', toolName: 't', args: {}, createdAt: '2026-01-04T00:00:00.000Z', kind: 'tool', deadline: '2000-01-01T00:00:00.000Z' })
    );

    const items = await new InboxService(deps()).list();
    expect(items.map((item) => item.id)).toEqual(['approval:a2:held', 'approval:a1:ap1']);
    // a1's expiresAt is the store record's, not the status deadline.
    expect(items[1]).toMatchObject({ expiresAt: '2099-02-01T00:00:00.000Z' });
  });

  it('clips title/detail copy at 140 chars', async () => {
    statuses.set(
      'a1',
      pausedWith({
        approvalId: 'ap1',
        toolName: 't',
        args: { blob: 'x'.repeat(500) },
        createdAt: '2026-01-04T00:00:00.000Z',
        kind: 'tool',
        deadline: '2099-01-04T00:10:00.000Z',
      })
    );
    const items = await new InboxService(deps()).list();
    expect(items[0].detail).toHaveLength(140);
  });

  it('refresh publishes inbox.count only when the count changed', async () => {
    const service = new InboxService(deps());
    const published: number[] = [];
    events.subscribe((event) => {
      if (event.type === 'inbox.count') published.push(event.count);
    });
    await service.refresh();
    await service.refresh();
    expect(published).toEqual([0]);
    drafts.set('a1', draft());
    await service.refresh();
    await service.refresh();
    expect(published).toEqual([0, 1]);
  });

  it('start() recounts on status pushes, bus events and alert changes (debounced)', async () => {
    vi.useFakeTimers();
    try {
      // An in-memory alerts stub keeps refresh() off real fs I/O, which
      // fake timers can't await; its onChange stands in for AlertStore writes.
      let onAlertChange: (() => void) | undefined;
      const d = deps();
      d.alerts = {
        list: async () => [],
        onChange: (listener: () => void) => {
          onAlertChange = listener;
          return () => undefined;
        },
      } as unknown as AlertStore;
      const service = new InboxService(d);
      const published: number[] = [];
      events.subscribe((event) => {
        if (event.type === 'inbox.count') published.push(event.count);
      });
      service.start();
      // A burst of triggers collapses into one recount.
      events.publish({ type: 'draft.changed', agentId: 'a1', draftId: 'd1', status: 'pending' });
      events.publish({ type: 'suggestion.new', agentId: 'a1', suggestionId: 's1' });
      events.publish({ type: 'agent.changed', agentId: 'a1', reason: 'save' });
      onAlertChange?.();
      await vi.advanceTimersByTimeAsync(300);
      expect(published).toEqual([0]);
      drafts.set('a1', draft());
      events.publish({ type: 'draft.changed', agentId: 'a1', draftId: 'd1', status: 'pending' });
      await vi.advanceTimersByTimeAsync(300);
      expect(published).toEqual([0, 1]);
      service.stop();
      events.publish({ type: 'draft.changed', agentId: 'a1', draftId: 'd1', status: 'pending' });
      await vi.advanceTimersByTimeAsync(300);
      expect(published).toEqual([0, 1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('dismissAlert returns false for unknown, dismissed or foreign-workspace alerts and refreshes on success', async () => {
    const service = new InboxService(deps());
    const published: number[] = [];
    events.subscribe((event) => {
      if (event.type === 'inbox.count') published.push(event.count);
    });
    await service.refresh();
    expect(await service.dismissAlert('alert_nope')).toBe(false);
    const foreign = await alerts.add({ kind: 'low_rating', agentId: 'a2', workspaceId: 'other-ws', title: 'x', detail: null, payload: {} });
    expect(await service.dismissAlert(foreign.id)).toBe(false);
    const own = await alerts.add({ kind: 'auto_disabled', agentId: 'a2', workspaceId: WS, title: 'y', detail: null, payload: {} });
    await service.refresh();
    expect(await service.dismissAlert(own.id)).toBe(true);
    expect(await service.dismissAlert(own.id)).toBe(false);
    expect(published).toEqual([0, 1, 0]);
  });
});
