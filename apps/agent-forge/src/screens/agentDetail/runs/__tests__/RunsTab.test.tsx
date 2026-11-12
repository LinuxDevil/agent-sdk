import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRecord, TraceSummaryPayload } from '../../../../../shared/wireTypes';
import type { AgentSpecV2 } from 'lousho/spec';
import type { ObserveScoreRow } from '../../../../observe/types';
import { render } from '../../../../ui/__tests__/render';

const mocks = vi.hoisted(() => ({ listTraces: vi.fn(), listScores: vi.fn(), rateRun: vi.fn() }));

vi.mock('../../../../runtime/runtimeClient', () => ({
  runtimeClient: { listTraces: mocks.listTraces, rateRun: mocks.rateRun },
  RuntimeApiError: class RuntimeApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock('../../../../observe/observeClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../observe/observeClient')>();
  return { ...actual, observeClient: { listScores: mocks.listScores } };
});

import { ObserveDaemonDownError } from '../../../../observe/observeClient';
import { ToastProvider } from '../../../../ui/Toast';
import { AgentDetailContext } from '../../AgentDetailContext';
import { RunsTab } from '../RunsTab';

function meta(): AgentRecord['meta'] {
  return {
    schemaVersion: 1,
    enabled: true,
    disabledAt: null,
    disabledReason: null,
    failureStreak: 0,
    labels: [],
    publishedVersion: null,
    createdAt: '2026-10-29T09:00:00Z',
    updatedAt: '2026-10-29T09:00:00Z',
  };
}

function record(): AgentRecord {
  return {
    id: 'support-bot',
    spec: {
      version: 2,
      name: 'Support bot',
      model: 'anthropic/claude-sonnet-5-5',
      instructions: 'Be helpful.',
    } as AgentSpecV2,
    meta: meta(),
    layout: { schemaVersion: 1, nodes: {}, notes: [] },
    updatedAt: '2026-10-29T10:00:00Z',
    latestVersion: null,
    publishState: { version: null, matchesWorkingCopy: false, publishedAt: null },
    requirements: [],
  };
}

function trace(id: string, over: Partial<TraceSummaryPayload> = {}): TraceSummaryPayload {
  return {
    traceId: id,
    name: `Run ${id}`,
    startTime: Date.now() - 180_000,
    durationMs: 1200,
    status: 'ok',
    modelCalls: 1,
    toolCalls: 0,
    inputTokens: 100,
    outputTokens: 20,
    ...over,
  };
}

function score(traceId: string, value: number, comment: string | null = null): ObserveScoreRow {
  return {
    score_id: `${traceId}-1`,
    trace_id: traceId,
    obs_id: null,
    name: 'rating',
    value,
    source: 'human',
    comment,
    agent_id: null,
    created_at: 1,
  };
}

/** Mounts the tab inside the detail context the route provides. */
function renderTab() {
  return render(
    <ToastProvider>
      <AgentDetailContext.Provider value={{ record: record(), refresh: () => {}, setRecord: () => {} }}>
        <RunsTab />
      </AgentDetailContext.Provider>
    </ToastProvider>,
  );
}

/** Flushes the allSettled fetch chain and applies the state updates inside act. */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

/** Clicks the toolbar's Refresh or the error card's Retry and flushes. */
async function clickAndFlush(host: HTMLElement, label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.includes(label),
  )!;
  act(() => button.click());
  await flush();
}

beforeEach(() => {
  mocks.listTraces.mockReset();
  mocks.listScores.mockReset();
  mocks.rateRun.mockReset();
  mocks.rateRun.mockResolvedValue(undefined);
  mocks.listTraces.mockResolvedValue([]);
  mocks.listScores.mockResolvedValue([]);
});

describe('RunsTab', () => {
  it('shows the loading skeleton while the first fetch is in flight', async () => {
    mocks.listTraces.mockReturnValue(new Promise(() => {}));
    const host = renderTab();
    await flush();

    const status = host.querySelector('[role="status"]');
    expect(status?.textContent).toBe('Loading');
  });

  it('lists runs newest first with status, rating, open-trace link and the count', async () => {
    mocks.listTraces.mockResolvedValue([
      trace('t1', { name: 'Run the agent.' }),
      trace('t2', { status: 'error', name: 'Refund request' }),
    ]);
    mocks.listScores.mockResolvedValue([score('t1', 4, 'nice'), score('t2', 2, 'bad')]);
    const host = renderTab();
    await flush();

    const rows = host.querySelectorAll('tbody tr');
    expect(rows.length).toBe(2);
    expect(rows[0].querySelector('.status-badge-label')?.textContent).toBe('Done');
    expect(rows[1].querySelector('.status-badge-label')?.textContent).toBe('Failed');

    // R04b: the rating column is the 1-5 RatingControl - t1's stored 4
    // checks option 4 and lights options 1-4.
    const rating = rows[0].querySelector('.rating[role="radiogroup"]')!;
    expect(rating.querySelector('[aria-label="4, Great"]')?.getAttribute('aria-checked')).toBe('true');
    expect(rows[0].querySelectorAll('.rating-option-on').length).toBe(4);
    expect(rows[1].querySelectorAll('.rating-option-on').length).toBe(2);

    const open = rows[0].querySelector<HTMLAnchorElement>('a[href="#/traces/t1"]')!;
    expect(open.textContent).toBe('Open trace');
    expect(open.getAttribute('aria-label')).toBe('Open trace t1');
    expect(host.querySelector('.runs-count')?.textContent).toBe('2 runs');
  });

  it('degrades to dashes and a note when the observe daemon is down', async () => {
    mocks.listTraces.mockResolvedValue([trace('t1')]);
    mocks.listScores.mockRejectedValue(new ObserveDaemonDownError('down'));
    const host = renderTab();
    await flush();

    expect(host.querySelectorAll('tbody tr').length).toBe(1);
    // No stored rating: every option renders unselected.
    expect(host.querySelector('.rating-option-on')).toBeNull();
    expect(host.querySelector('.runs-note')?.textContent).toContain(
      'Ratings need the observe daemon (lousho observe). Runs still show.',
    );
  });

  it('shows the empty state with a Test pane link when there are no runs', async () => {
    const host = renderTab();
    await flush();

    expect(host.textContent).toContain('No runs yet');
    const link = host.querySelector<HTMLAnchorElement>('a.btn-primary')!;
    expect(link.textContent).toBe('Open the Test pane');
    expect(link.getAttribute('href')).toBe('#/agents/support-bot/canvas?test=1');
  });

  it('shows a retryable error when the run list fails', async () => {
    mocks.listTraces.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([trace('t-9')]);
    const host = renderTab();
    await flush();

    expect(host.textContent).toContain('Could not load runs');
    await clickAndFlush(host, 'Retry');

    expect(mocks.listTraces).toHaveBeenCalledTimes(2);
    expect(host.querySelectorAll('tbody tr').length).toBe(1);
  });

  it('posts the picked rating for the row’s trace (R04b)', async () => {
    mocks.listTraces.mockResolvedValue([trace('t1'), trace('t2')]);
    const host = renderTab();
    await flush();

    const option = host.querySelector<HTMLButtonElement>('tbody tr:nth-child(2) [aria-label="2, Fair"]')!;
    // Synchronous act: the optimistic paint lands before the post-save
    // refresh unmounts the table behind its loading skeleton.
    act(() => option.click());

    expect(mocks.rateRun).toHaveBeenCalledWith('support-bot', { traceId: 't2', value: 2 });
    const row = host.querySelectorAll('tbody tr')[1];
    expect(row.querySelectorAll('.rating-option-on').length).toBe(2);
    expect(row.querySelector('[aria-label="2, Fair"]')?.getAttribute('aria-checked')).toBe('true');
    await flush();
  });

  it('Refresh refetches both the runs and the ratings', async () => {
    mocks.listTraces.mockResolvedValue([trace('t1')]);
    const host = renderTab();
    await flush();
    expect(mocks.listTraces).toHaveBeenCalledTimes(1);
    expect(mocks.listScores).toHaveBeenCalledTimes(1);

    await clickAndFlush(host, 'Refresh');

    expect(mocks.listTraces).toHaveBeenCalledTimes(2);
    expect(mocks.listScores).toHaveBeenCalledTimes(2);
    expect(mocks.listTraces).toHaveBeenLastCalledWith('support-bot', 100);
    expect(mocks.listScores).toHaveBeenLastCalledWith({ name: 'rating', source: 'human', limit: 1000 });
  });
});
