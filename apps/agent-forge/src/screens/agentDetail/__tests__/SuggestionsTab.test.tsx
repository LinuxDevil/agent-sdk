import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRecord, DraftView, PromptSuggestion, StudioEvent } from '../../../../shared/wireTypes';
import type { AgentSpecV2 } from 'lousho/spec';
import { render } from '../../../ui/__tests__/render';
import { ToastProvider } from '../../../ui/Toast';

const mocks = vi.hoisted(() => ({
  getDraft: vi.fn(),
  listSuggestions: vi.fn(),
  eventHandlers: [] as Array<(event: StudioEvent) => void>,
}));

vi.mock('../../../runtime/runtimeClient', () => ({
  runtimeClient: { getDraft: mocks.getDraft, listSuggestions: mocks.listSuggestions },
}));

vi.mock('../../../state/useStudioEvents', () => ({
  useStudioEvents: (handler: (event: StudioEvent) => void) => {
    mocks.eventHandlers.push(handler);
  },
}));

// The DraftCard inside the tab reads the app document's reload on approve.
vi.mock('../../../state/AppState', () => ({
  useAppState: () => ({ reload: vi.fn(() => Promise.resolve(true)) }),
}));

import { AgentDetailContext } from '../AgentDetailContext';
import { SuggestionsTab } from '../SuggestionsTab';

function record(): AgentRecord {
  return {
    id: 'support-bot',
    spec: { version: 2, name: 'Support bot', model: 'anthropic/claude-sonnet-5-5' } as AgentSpecV2,
    meta: {
      schemaVersion: 1,
      enabled: true,
      disabledAt: null,
      disabledReason: null,
      failureStreak: 0,
      labels: [],
      publishedVersion: null,
      createdAt: '2026-10-29T09:00:00Z',
      updatedAt: '2026-10-29T09:00:00Z',
    },
    layout: { schemaVersion: 1, nodes: {}, notes: [] },
    updatedAt: '2026-10-29T10:00:00Z',
    latestVersion: null,
    publishState: { version: null, matchesWorkingCopy: false, publishedAt: null },
    requirements: [],
  };
}

function draftView(over: Partial<DraftView> = {}): DraftView {
  return {
    id: 'd1',
    agentId: 'support-bot',
    status: 'pending',
    origin: 'author',
    patch: { model: 'openai/gpt-5' },
    reason: 'Switch to a cheaper model.',
    baseVersion: 3,
    baseSpecHash: 'sha256:x',
    autoReview: null,
    classes: null,
    note: null,
    createdAt: new Date(Date.now() - 300_000).toISOString(),
    updatedAt: new Date(Date.now() - 300_000).toISOString(),
    respondedAt: null,
    changes: [
      {
        field: 'model',
        label: 'Model',
        section: 'Model',
        op: 'edit',
        before: 'anthropic/claude-sonnet-5-5',
        after: 'openai/gpt-5',
      },
    ],
    currentVersion: 3,
    ...over,
  };
}

/** Mounts the tab inside the detail context and toast provider the route provides. */
function renderTab() {
  return render(
    <ToastProvider>
      <AgentDetailContext.Provider value={{ record: record(), refresh: () => {}, setRecord: () => {} }}>
        <SuggestionsTab />
      </AgentDetailContext.Provider>
    </ToastProvider>,
  );
}

/** Flushes the fetch chain and applies the state updates inside act. */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

function promptSuggestion(over: Partial<PromptSuggestion> = {}): PromptSuggestion {
  return {
    kind: 'prompt_edit',
    id: 'sg-1',
    agentId: 'support-bot',
    sourceTraceId: 'trace-abc12345-6789',
    expectedPromptHash: 'hash-before',
    proposedPromptHash: 'hash-after',
    oldText: 'Be helpful.',
    newText: 'Be helpful and concise.',
    confidence: 'high',
    optimizationClass: 'Ambiguous instruction',
    evidence: 'The run asked twice.',
    expectedSaving: 'About 2s per run.',
    risk: 'Low.',
    validationPlan: ['Run the agent once'],
    status: 'open',
    createdAt: new Date(Date.now() - 180_000).toISOString(),
    updatedAt: new Date(Date.now() - 180_000).toISOString(),
    resolvedAt: null,
    appliedVersion: null,
    ...over,
  };
}

/** Fires `event` on every subscribed handler (the tab mounts two: draft + suggestions). The mock registers on each render, so dedupe by identity. */
function emit(event: StudioEvent) {
  for (const handler of new Set(mocks.eventHandlers)) handler(event);
}

beforeEach(() => {
  mocks.getDraft.mockReset();
  mocks.getDraft.mockResolvedValue(undefined);
  mocks.listSuggestions.mockReset();
  mocks.listSuggestions.mockResolvedValue([]);
  mocks.eventHandlers = [];
  window.location.hash = '';
});

describe('SuggestionsTab', () => {
  it('shows the loading skeleton while the first fetch is in flight', async () => {
    mocks.getDraft.mockReturnValue(new Promise(() => {}));
    const host = renderTab();
    await flush();

    expect(host.querySelector('.skeleton')).not.toBeNull();
    expect(host.querySelector('[role="status"]')).not.toBeNull();
  });

  it('shows the empty state when no draft is pending', async () => {
    const host = renderTab();
    await flush();

    expect(host.querySelector('.empty-state-title')?.textContent).toBe('No suggestions yet');
    expect(host.querySelector('.empty-state-hint')?.textContent).toBe(
      'Rate a run 2 or lower, or use Suggest a fix on a run, to get a suggested instruction change.',
    );
    expect(host.querySelector('.draft-card')).toBeNull();
  });

  it('renders the pending draft card', async () => {
    mocks.getDraft.mockResolvedValue(draftView());
    const host = renderTab();
    await flush();

    expect(host.querySelector('.draft-card')).not.toBeNull();
    expect(host.querySelector('#draft-title')?.textContent).toBe('Pending change');
    expect(host.querySelector('.draft-card-reason')?.textContent).toBe('Switch to a cheaper model.');
  });

  it('refetches on draft.changed for this agent and swaps in the verdict', async () => {
    mocks.getDraft.mockResolvedValueOnce(draftView()).mockResolvedValue(draftView({
      autoReview: {
        outcome: 'clear',
        safe: true,
        rationale: 'Looks routine.',
        concerns: [],
        fingerprint: 'fp',
        model: 'mock/mock-1',
        checkedAt: '2026-11-12T00:00:00Z',
      },
    }));
    const host = renderTab();
    await flush();
    expect(host.querySelector('.draft-review')?.getAttribute('data-outcome')).toBe('pending');
    expect(mocks.getDraft).toHaveBeenCalledTimes(1);

    act(() => {
      emit({ type: 'draft.changed', agentId: 'support-bot', draftId: 'd1', status: 'pending' });
    });
    await flush();

    expect(mocks.getDraft).toHaveBeenCalledTimes(2);
    expect(host.querySelector('.draft-review')?.getAttribute('data-outcome')).toBe('clear');
    expect(host.textContent).toContain('No safety concerns found.');
  });

  it('ignores draft.changed events for other agents', async () => {
    mocks.getDraft.mockResolvedValue(draftView());
    const host = renderTab();
    await flush();

    act(() => {
      emit({ type: 'draft.changed', agentId: 'other-agent', draftId: 'd9', status: 'pending' });
    });
    await flush();

    expect(mocks.getDraft).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.draft-card')).not.toBeNull();
  });

  it('refetches on agent.changed with a spec-moving reason', async () => {
    mocks.getDraft.mockResolvedValue(draftView());
    renderTab();
    await flush();

    act(() => {
      emit({ type: 'agent.changed', agentId: 'support-bot', reason: 'version' });
    });
    await flush();
    expect(mocks.getDraft).toHaveBeenCalledTimes(2);

    act(() => {
      emit({ type: 'agent.changed', agentId: 'support-bot', reason: 'meta' });
    });
    await flush();
    expect(mocks.getDraft).toHaveBeenCalledTimes(2);
  });

  it('shows the empty state after the draft resolves', async () => {
    mocks.getDraft.mockResolvedValueOnce(draftView()).mockResolvedValue(undefined);
    const host = renderTab();
    await flush();
    expect(host.querySelector('.draft-card')).not.toBeNull();

    act(() => {
      emit({ type: 'draft.changed', agentId: 'support-bot', draftId: 'd1', status: 'approved' });
    });
    await flush();

    expect(host.querySelector('.draft-card')).toBeNull();
    expect(host.querySelector('.empty-state-title')?.textContent).toBe('No suggestions yet');
  });

  it('shows the error state with a Retry action', async () => {
    mocks.getDraft.mockRejectedValue(new Error('boom'));
    const host = renderTab();
    await flush();

    expect(host.querySelector('.empty-state-title')?.textContent).toBe('Could not load suggestions');
    expect(host.querySelector('.empty-state-hint')?.textContent).toBe('boom');
    const retry = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Retry')!;
    act(() => retry.click());
    await flush();
    expect(mocks.getDraft).toHaveBeenCalledTimes(2);
  });

  it('lists prompt suggestions as cards below the draft card', async () => {
    mocks.getDraft.mockResolvedValue(draftView());
    mocks.listSuggestions.mockResolvedValue([
      promptSuggestion(),
      promptSuggestion({ id: 'sg-2', status: 'dismissed' }),
      promptSuggestion({ id: 'sg-3', status: 'conflict' }),
    ]);
    const host = renderTab();
    await flush();

    expect(host.querySelector('.draft-card')).not.toBeNull();
    const cards = [...host.querySelectorAll<HTMLElement>('.suggestion-card')];
    expect(cards).toHaveLength(2);
    expect(cards[0].getAttribute('data-status')).toBe('open');
    expect(cards[1].getAttribute('data-status')).toBe('conflict');
    expect(host.querySelector('#suggestions-title')?.textContent).toContain('Suggestions');
    // The dismissed record stays in the store but never renders.
    expect(host.querySelector('#sg-sg-2-title')).toBeNull();
  });

  it('shows the pending skeleton for ?suggesting=<id> until suggestion.new lands the record', async () => {
    window.location.hash = '#/agents/support-bot/suggestions?suggesting=sg-9';
    mocks.listSuggestions.mockResolvedValue([]);
    const host = renderTab();
    await flush();

    expect(host.querySelector('.suggestion-card-pending')?.textContent).toContain('Working on a suggestion…');

    // The pass finishes: the event refetches and the record replaces the skeleton.
    mocks.listSuggestions.mockResolvedValue([promptSuggestion({ id: 'sg-9' })]);
    act(() => {
      emit({ type: 'suggestion.new', agentId: 'support-bot', suggestionId: 'sg-9' });
    });
    await flush();

    expect(host.querySelector('.suggestion-card-pending')).toBeNull();
    expect(host.querySelector('#sg-sg-9-title')).not.toBeNull();
  });

  it('refetches the list on suggestion.new for this agent only', async () => {
    mocks.listSuggestions.mockResolvedValue([]);
    renderTab();
    await flush();
    expect(mocks.listSuggestions).toHaveBeenCalledTimes(1);

    act(() => {
      emit({ type: 'suggestion.new', agentId: 'other-agent', suggestionId: 'sg-x' });
    });
    await flush();
    expect(mocks.listSuggestions).toHaveBeenCalledTimes(1);

    act(() => {
      emit({ type: 'suggestion.new', agentId: 'support-bot', suggestionId: 'sg-1' });
    });
    await flush();
    expect(mocks.listSuggestions).toHaveBeenCalledTimes(2);
  });
});
