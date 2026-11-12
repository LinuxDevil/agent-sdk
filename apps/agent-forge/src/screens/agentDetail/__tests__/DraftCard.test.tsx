import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRecord, DraftAutoReview, DraftView, SpecChange } from '../../../../shared/wireTypes';
import type { AgentSpecV2 } from 'lousho/spec';
import { render } from '../../../ui/__tests__/render';
import { ToastProvider } from '../../../ui/Toast';

const mocks = vi.hoisted(() => ({
  approveDraft: vi.fn(),
  rejectDraft: vi.fn(),
}));

vi.mock('../../../runtime/runtimeClient', () => ({
  runtimeClient: {
    approveDraft: mocks.approveDraft,
    rejectDraft: mocks.rejectDraft,
  },
}));

const appState = vi.hoisted(() => ({
  reload: vi.fn<[options?: { discardLocal?: boolean }], Promise<boolean>>(() => Promise.resolve(true)),
}));
vi.mock('../../../state/AppState', () => ({ useAppState: () => appState }));

import { AgentDetailContext } from '../AgentDetailContext';
import { DraftCard } from '../DraftCard';

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
    requirements: [],
  };
}

const MODEL_CHANGE: SpecChange = {
  field: 'model',
  label: 'Model',
  section: 'Model',
  op: 'edit',
  before: 'anthropic/claude-sonnet-5-5',
  after: 'openai/gpt-5',
};

const TOOL_CHANGE: SpecChange = {
  field: 'tools[web-fetch]',
  label: 'Tool: web-fetch',
  section: 'Tools',
  op: 'add',
  after: { name: 'web-fetch' },
};

function review(over: Partial<DraftAutoReview> = {}): DraftAutoReview {
  return {
    outcome: 'clear',
    safe: true,
    rationale: 'Looks routine.',
    concerns: [],
    fingerprint: 'fp',
    model: 'mock/mock-1',
    checkedAt: '2026-11-12T00:00:00Z',
    ...over,
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
    changes: [MODEL_CHANGE],
    currentVersion: 3,
    ...over,
  };
}

/** Mounts the card inside the providers the detail screen gives it. */
function renderCard(draft: DraftView = draftView(), onResolved = vi.fn(), refresh = vi.fn()) {
  const host = render(
    <ToastProvider>
      <AgentDetailContext.Provider value={{ record: record(), refresh, setRecord: () => {} }}>
        <DraftCard agentId="support-bot" draft={draft} onResolved={onResolved} />
      </AgentDetailContext.Provider>
    </ToastProvider>,
  );
  return { host, onResolved, refresh };
}

/** Flushes the settle promise chain and applies the state updates inside act. */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

/** Clicks the first button whose text contains `label` and flushes. */
async function clickAndFlush(host: HTMLElement, label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.includes(label),
  )!;
  act(() => button.click());
  await flush();
}

beforeEach(() => {
  mocks.approveDraft.mockReset();
  mocks.rejectDraft.mockReset();
  mocks.approveDraft.mockResolvedValue({ status: 'approved' });
  mocks.rejectDraft.mockResolvedValue({ status: 'rejected' });
  appState.reload.mockClear();
});

describe('DraftCard', () => {
  it('shows the header, origin chip, reason and the pending review skeleton', () => {
    const { host } = renderCard(draftView({ origin: 'suggestion' }));

    expect(host.querySelector('#draft-title')?.textContent).toBe('Pending change');
    expect(host.querySelector('.draft-card-header .chip')?.textContent).toBe('From a suggestion');
    expect(host.querySelector('.draft-card-reason')?.textContent).toBe('Switch to a cheaper model.');
    const review = host.querySelector('.draft-review')!;
    expect(review.getAttribute('data-outcome')).toBe('pending');
    expect(review.querySelector('.draft-review-skeleton')).not.toBeNull();
    expect(review.textContent).toContain('Checking this change…');
  });

  it('maps each origin to its chip label', () => {
    for (const [origin, label] of [
      ['author', 'From the Author'],
      ['suggestion', 'From a suggestion'],
      ['manual', 'Added by you'],
    ] as const) {
      const { host } = renderCard(draftView({ origin }));
      expect(host.querySelector('.draft-card-header .chip')?.textContent).toBe(label);
    }
  });

  it('shows the clear verdict with its rationale', () => {
    const { host } = renderCard(draftView({ autoReview: review() }));
    const block = host.querySelector('.draft-review')!;
    expect(block.getAttribute('data-outcome')).toBe('clear');
    expect(block.textContent).toContain('No safety concerns found.');
    expect(block.textContent).toContain('Looks routine.');
  });

  it('shows the escalated verdict and its concerns with area labels', () => {
    const { host } = renderCard(
      draftView({
        autoReview: review({
          outcome: 'escalated',
          safe: false,
          rationale: 'Drops a guardrail.',
          concerns: [
            { area: 'safety', detail: 'Removes the approval gate.' },
            { area: 'coherence', detail: 'Conflicts with the flow.' },
            { area: 'trigger_reach', detail: 'Cron fires hourly.' },
          ],
        }),
      }),
    );
    const block = host.querySelector('.draft-review')!;
    expect(block.getAttribute('data-outcome')).toBe('escalated');
    expect(block.textContent).toContain('Read this change carefully.');
    const items = [...block.querySelectorAll('.draft-concerns li')];
    expect(items.map((li) => li.querySelector('.chip')?.textContent)).toEqual(['Safety', 'Fits the agent?', 'Who can start it']);
    expect(items[0].textContent).toContain('Removes the approval gate.');
  });

  it('shows the unavailable verdict with the server rationale', () => {
    const { host } = renderCard(
      draftView({ autoReview: review({ outcome: 'unavailable', safe: null, rationale: 'No model key for the automatic check.' }) }),
    );
    const block = host.querySelector('.draft-review')!;
    expect(block.getAttribute('data-outcome')).toBe('unavailable');
    expect(block.textContent).toContain('No model key for the automatic check.');
    expect(block.querySelector('.draft-concerns')).toBeNull();
  });

  it('shows the gated sentence grouped by field with op verbs', () => {
    const { host } = renderCard(
      draftView({
        classes: { routine: ['instructions'], gated: ['model', 'tools[web-fetch]'] },
        changes: [MODEL_CHANGE, TOOL_CHANGE],
      }),
    );
    expect(host.querySelector('.draft-gated')?.textContent).toBe('Needs your approval: changes Model, adds Tools.');
  });

  it('hides the gated line when every field is routine or unclassified', () => {
    const { host } = renderCard(draftView({ classes: { routine: ['instructions'], gated: [] } }));
    expect(host.querySelector('.draft-gated')).toBeNull();
    const unclassified = renderCard(draftView());
    expect(unclassified.host.querySelector('.draft-gated')).toBeNull();
  });

  it('shows the drift banner only when currentVersion > baseVersion', () => {
    const drifted = renderCard(draftView({ baseVersion: 5, currentVersion: 7 }));
    expect(drifted.host.querySelector('.draft-drift')?.textContent).toContain(
      'The agent changed since this draft was made (v5 → v7). Approving applies the draft on top of v7.',
    );

    const current = renderCard(draftView({ baseVersion: 5, currentVersion: 5 }));
    expect(current.host.querySelector('.draft-drift')).toBeNull();

    const noBase = renderCard(draftView({ baseVersion: null, currentVersion: 2 }));
    expect(noBase.host.querySelector('.draft-drift')).toBeNull();
  });

  it('Approve settles with the draft id, toasts the new version, reloads and resolves', async () => {
    const { host, onResolved, refresh } = renderCard(draftView({ currentVersion: 4 }));
    await clickAndFlush(host, 'Approve');

    expect(mocks.approveDraft).toHaveBeenCalledWith('support-bot', { draftId: 'd1' });
    expect(host.querySelector('.toast-message')?.textContent).toBe('Applied the change as v5');
    expect(appState.reload).toHaveBeenCalledWith({ discardLocal: true });
    expect(refresh).toHaveBeenCalled();
    expect(onResolved).toHaveBeenCalled();
  });

  it('Reject expands the note form and sends the note', async () => {
    const { host, onResolved } = renderCard();
    await clickAndFlush(host, 'Reject');

    const textarea = host.querySelector<HTMLTextAreaElement>('.draft-reject textarea')!;
    expect(textarea).not.toBeNull();
    act(() => {
      // React's onChange listens to the input event.
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, 'Not needed.');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();

    await clickAndFlush(host, 'Reject change');
    expect(mocks.rejectDraft).toHaveBeenCalledWith('support-bot', { draftId: 'd1', note: 'Not needed.' });
    expect(host.querySelector('.toast-message')?.textContent).toBe('Rejected the change');
    expect(onResolved).toHaveBeenCalled();
  });

  it('Reject without a note sends undefined and Cancel closes the form', async () => {
    const { host } = renderCard();
    await clickAndFlush(host, 'Reject');
    await clickAndFlush(host, 'Cancel');
    expect(host.querySelector('.draft-reject')).toBeNull();

    await clickAndFlush(host, 'Reject');
    await clickAndFlush(host, 'Reject change');
    expect(mocks.rejectDraft).toHaveBeenCalledWith('support-bot', { draftId: 'd1', note: undefined });
  });

  it('keeps the card and shows the error when approve fails', async () => {
    mocks.approveDraft.mockRejectedValue(new Error('stale draft'));
    const { host, onResolved } = renderCard();
    await clickAndFlush(host, 'Approve');

    expect(host.querySelector('.draft-error')?.textContent).toBe('stale draft');
    expect(host.querySelector('.draft-card')).not.toBeNull();
    const approve = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Approve')!;
    expect(approve.disabled).toBe(false);
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('shows the reject error inside the expanded form', async () => {
    mocks.rejectDraft.mockRejectedValue(new Error('nope'));
    const { host } = renderCard();
    await clickAndFlush(host, 'Reject');
    await clickAndFlush(host, 'Reject change');

    expect(host.querySelector('.draft-error')?.textContent).toBe('nope');
    expect(host.querySelector('.draft-card')).not.toBeNull();
  });
});
