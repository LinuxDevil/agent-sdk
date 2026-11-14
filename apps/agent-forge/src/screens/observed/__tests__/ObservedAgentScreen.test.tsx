import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { render } from '../../../ui/__tests__/render';
import { ToastProvider } from '../../../ui/Toast';
import type { ScreenHeaderProps } from '../../../shell/ScreenHeader';
import type { ObserveAgentRow, ObserveScorePassRate, ObserveScoreRow, ObserveTraceRow } from '../../../observe/types';
import { ObservedAgentScreen } from '../ObservedAgentScreen';

// The shell's header needs the app state; here it renders its props in place.
vi.mock('../../../shell/ScreenHeader', () => ({
  ScreenHeader: ({ title, description, breadcrumbs }: ScreenHeaderProps) => (
    <header className="test-screen-header">
      <h1>{title}</h1>
      <p>{description}</p>
      <nav aria-label="Breadcrumb">
        {(breadcrumbs ?? []).map((c) => (
          <span key={c.label}>{c.label}</span>
        ))}
      </nav>
    </header>
  ),
}));

const T0 = 1_700_000_000_000;

function agentRow(over: Partial<ObserveAgentRow>): ObserveAgentRow {
  return {
    agent_id: 'inst-1',
    project: 'billing-svc',
    name: 'billing-worker',
    version: '1.2.0',
    first_seen: T0 - 86_400_000,
    last_heartbeat: T0,
    status: 'healthy',
    heartbeat_age_ms: 1000,
    heartbeat_interval_ms: 30_000,
    hostname: 'host-a',
    pid: 4242,
    dropped: null,
    runs_today: 10,
    error_rate_today: 0.01,
    ...over,
  };
}

const INSTANCES: ObserveAgentRow[] = [
  agentRow({ agent_id: 'inst-new', hostname: 'host-b', pid: 777, version: '1.3.0', last_heartbeat: T0 }),
  agentRow({ agent_id: 'inst-old', hostname: 'host-a', pid: 4242, version: '1.2.0', last_heartbeat: T0 - 60_000, status: 'stale' }),
];

function traceRow(over: Partial<ObserveTraceRow>): ObserveTraceRow {
  return {
    trace_id: 'tr-1',
    name: 'run',
    agent_id: 'inst-new',
    session_id: null,
    start: T0,
    end: T0 + 1200,
    status: 'ok',
    observations: 3,
    generations: 1,
    tools: 1,
    errors: 0,
    input_tokens: 100,
    output_tokens: 40,
    cost_usd: 0.01,
    agent_name: 'billing-worker',
    model: 'gpt-5',
    error_message: null,
    input_preview: null,
    output_preview: null,
    ...over,
  };
}

const TRACES: ObserveTraceRow[] = [
  traceRow({ trace_id: 'tr-new', agent_id: 'inst-new', start: T0 }),
  traceRow({ trace_id: 'tr-old', agent_id: 'inst-old', start: T0 - 5000, status: 'error', end: T0 - 4000 }),
];

function scoreRow(over: Partial<ObserveScoreRow>): ObserveScoreRow {
  return {
    score_id: 'sc-1',
    trace_id: 'tr-new',
    obs_id: null,
    name: 'helpfulness',
    value: 0.9,
    source: 'judge',
    comment: null,
    agent_id: 'inst-new',
    created_at: T0,
    ...over,
  };
}

const SCORES: ObserveScoreRow[] = [scoreRow({})];

const PASS_RATES: ObserveScorePassRate[] = [
  { name: 'billing-eval', count: 8, passed: 7, pass_rate: 0.875, avg_value: 0.9, last_ts: T0 },
];

interface DaemonState {
  agents: ObserveAgentRow[];
  traces: Record<string, ObserveTraceRow[]>;
  scores: Record<string, ObserveScoreRow[]>;
  passRates: ObserveScorePassRate[];
  down: boolean;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A stand-in collector behind the `/observe` proxy. */
function daemon(state: Partial<DaemonState> = {}) {
  const s: DaemonState = {
    agents: INSTANCES,
    traces: { 'inst-new': TRACES.slice(0, 1), 'inst-old': TRACES.slice(1) },
    scores: { 'inst-new': SCORES, 'inst-old': [] },
    passRates: PASS_RATES,
    down: false,
    ...state,
  };
  const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
    if (s.down) throw new TypeError('fetch failed');
    const url = String(input);
    if (url.includes('/api/v1/agents')) {
      const project = new URL(url, 'http://x').searchParams.get('project');
      const rows = project === null ? s.agents : s.agents.filter((a) => a.project === project);
      return json(200, { agents: rows });
    }
    if (url.includes('/api/v1/traces?')) {
      const agentId = new URL(url, 'http://x').searchParams.get('agent_id') ?? '';
      return json(200, { traces: s.traces[agentId] ?? [], total: 0, limit: 20, offset: 0 });
    }
    if (url.includes('/api/v1/scores') && url.includes('aggregate=eval')) {
      return json(200, { evals: s.passRates });
    }
    if (url.includes('/api/v1/scores')) {
      const agentId = new URL(url, 'http://x').searchParams.get('agent_id') ?? '';
      return json(200, { scores: s.scores[agentId] ?? [] });
    }
    return json(404, { error: `unexpected ${url}` });
  });
  vi.stubGlobal('fetch', fetchFn);
  return s;
}

async function waitFor(check: () => boolean, timeoutMs = 3000) {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error('waitFor timed out');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

function mount(agentId = 'inst-new') {
  return render(
    <ToastProvider>
      <ObservedAgentScreen agentId={agentId} />
    </ToastProvider>
  );
}

beforeEach(() => {
  window.history.replaceState(null, '', '/#/observed/inst-new');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('ObservedAgentScreen', () => {
  it('lists both instances, merged runs, scores and eval pass rates', async () => {
    daemon();
    const host = mount();
    await waitFor(() => host.textContent?.includes('billing-worker') === true && host.querySelectorAll('.data-table tbody tr').length >= 5);
    // Header: name + read-only description naming the project.
    expect(host.querySelector('h1')?.textContent).toBe('billing-worker');
    expect(host.textContent).toContain('Read-only. Reported by billing-svc to the collector.');
    // Instances card: both daemon rows.
    const instancesCard = [...host.querySelectorAll('.card')].find((c) => c.textContent?.includes('Instances'))!;
    expect(instancesCard.textContent).toContain('inst-new'.slice(0, 8));
    expect(instancesCard.textContent).toContain('host-b');
    expect(instancesCard.textContent).toContain('host-a');
    expect(instancesCard.querySelectorAll('tbody tr')).toHaveLength(2);
    // Recent runs: merged across instances, newest first (tr-new before tr-old).
    const runsCard = [...host.querySelectorAll('.card')].find((c) => c.textContent?.includes('Recent runs'))!;
    const runRows = [...runsCard.querySelectorAll('tbody tr')];
    expect(runRows).toHaveLength(2);
    expect(runRows[0].textContent).toContain('ok');
    expect(runRows[1].textContent).toContain('error');
    // Scores + evals.
    const scoresCard = [...host.querySelectorAll('.card')].find((c) => c.textContent?.includes('Scores'))!;
    expect(scoresCard.textContent).toContain('helpfulness');
    const evalsCard = [...host.querySelectorAll('.card')].find((c) => c.textContent?.includes('Evals'))!;
    expect(evalsCard.textContent).toContain('billing-eval — 7/8 passed');
  });

  it('opens a run row on its trace page', async () => {
    daemon();
    const host = mount();
    await waitFor(() => host.querySelectorAll('.data-table tbody tr').length >= 5);
    const runsCard = [...host.querySelectorAll('.card')].find((c) => c.textContent?.includes('Recent runs'))!;
    const row = runsCard.querySelector<HTMLElement>('tbody tr')!;
    await act(async () => row.click());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(window.location.hash).toBe('#/traces/tr-new');
  });

  it('shows "Agent not found" for an unknown id', async () => {
    daemon();
    const host = mount('no-such-id');
    await waitFor(() => host.textContent?.includes('Agent not found') === true);
    expect(host.textContent).toContain('The collector has no agent with this id.');
    const back = [...host.querySelectorAll('a')].find((a) => a.textContent === 'Back to agents');
    expect(back?.getAttribute('href')).toBe('#/agents');
  });

  it('shows the collector error with Retry, which refetches', async () => {
    const s = daemon({ down: true });
    const host = mount();
    await waitFor(() => host.textContent?.includes('Could not reach the collector') === true);
    s.down = false;
    const retry = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!;
    await act(async () => retry.click());
    await waitFor(() => host.querySelector('h1')?.textContent === 'billing-worker');
  });

  it('merges and cuts traces across instances, newest first', async () => {
    // 20 traces per instance; cost encodes recency so the row order is assertable
    // (the runs table shows no trace id). inst-new's are all newer than inst-old's.
    const many = (agentId: string, base: number, step: number): ObserveTraceRow[] =>
      Array.from({ length: 20 }, (_, i) =>
        traceRow({ trace_id: `${agentId}-${i}`, agent_id: agentId, start: base + i, cost_usd: (i + 1) * step })
      );
    daemon({
      traces: { 'inst-new': many('inst-new', T0, 0.001), 'inst-old': many('inst-old', T0 - 100_000, 0.01) },
    });
    const host = mount();
    await waitFor(() => host.textContent?.includes('Recent runs') === true && host.querySelectorAll('.data-table tbody tr').length >= 23);
    const runsCard = [...host.querySelectorAll('.card')].find((c) => c.textContent?.includes('Recent runs'))!;
    const rows = [...runsCard.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(20);
    // inst-new's 20 (all newer) fill the list, newest first: $0.020 then down to $0.001.
    expect(rows[0].textContent).toContain('$0.02');
    expect(rows[19].textContent).toContain('$0.0010');
  });
});
