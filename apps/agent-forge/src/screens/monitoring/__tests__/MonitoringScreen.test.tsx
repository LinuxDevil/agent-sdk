import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../state/AppState', () => ({ useAppState: () => ({ runStatus: null }) }));

import type { ObserveAgentRow, ObserveRollupRow } from '../../../observe/types';
import { render } from '../../../ui/__tests__/render';
import { MonitoringScreen, MONITORING_POLL_MS } from '../MonitoringScreen';
import { chartWindow } from '../monitoringSeries';

const NOW = Date.UTC(2026, 9, 25, 12, 30);
const HOUR = 3_600_000;

function agent(over: Partial<ObserveAgentRow> & { agent_id: string }): ObserveAgentRow {
  return {
    project: null,
    name: over.agent_id,
    version: null,
    first_seen: NOW - HOUR,
    last_heartbeat: NOW - 5000,
    status: 'healthy',
    heartbeat_age_ms: 5000,
    heartbeat_interval_ms: 30_000,
    hostname: null,
    pid: null,
    dropped: null,
    runs_today: 0,
    error_rate_today: 0,
    ...over,
  };
}

const AGENTS = [
  agent({ agent_id: 'a1', name: 'Support bot', status: 'stale', dropped: 7, runs_today: 12, error_rate_today: 0.25 }),
  agent({ agent_id: 'a2', name: 'Billing bot', dropped: null }),
];

const rollup = (bucket_start: number, agent_id: string, metric: string, value: number): ObserveRollupRow => ({
  bucket_start,
  granularity: 'hour',
  agent_id,
  metric,
  value,
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A stand-in daemon behind `/observe`; `down` fails every request like a refused connection. */
function daemon(series: ObserveRollupRow[] = []) {
  const state = { down: false, series };
  const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
    if (state.down) throw new TypeError('fetch failed');
    const url = String(input);
    if (url.startsWith('/observe/health')) return json(200, { service: 'lousho-observe', ok: true });
    if (url.startsWith('/observe/__target')) return json(200, { url: 'http://127.0.0.1:7777' });
    if (url.startsWith('/observe/api/v1/agents')) return json(200, { agents: AGENTS });
    if (url.startsWith('/observe/api/v1/insights')) {
      const q = new URL(url, 'http://x').searchParams;
      const p95 = { agent_id: 'a1', p95_latency_ms: 1500 };
      // The fleet's `days=1` call carries no series; the chart call gets the window's rows.
      return json(200, { window: { since: 0, until: 1 }, agents: [p95], series: q.has('days') ? [] : state.series });
    }
    return json(404, { error: `unexpected ${url}` });
  });
  vi.stubGlobal('fetch', fetchFn);
  const calls = (path: string) => fetchFn.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith(`/observe${path}`));
  return { state, fetchFn, calls };
}

/** Flush fetch promises and renders until `check` holds (timers are fake, so this counts turns, not ms). */
async function waitFor(check: () => boolean, turns = 50) {
  for (let i = 0; !check(); i++) {
    if (i > turns) throw new Error('waitFor gave up');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const fleetRow = (c: HTMLElement, name: string) =>
  [...c.querySelectorAll('.mon-fleet tbody tr')].find((tr) => tr.textContent!.includes(name)) as HTMLElement | undefined;
const chart = (c: HTMLElement, title: string) => c.querySelector(`[data-chart="${title}"]`) as HTMLElement | null;
/** The chart's plot is drawn (while loading, the card holds a skeleton instead). */
const drawn = (c: HTMLElement, title: string) => chart(c, title)?.querySelector('svg.tsc-svg') != null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(NOW);
  window.history.replaceState(null, '', '/#/monitoring');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('MonitoringScreen', () => {
  it('renders each fleet row with its status pill, dropped count, figures and traces link', async () => {
    daemon();
    const c = render(<MonitoringScreen />);
    await waitFor(() => fleetRow(c, 'Billing bot') !== undefined && fleetRow(c, 'Support bot')!.textContent!.includes('1.5s'));
    const support = fleetRow(c, 'Support bot')!;
    expect(support.querySelector('.status-pill.pill-warning')?.textContent).toBe('stale');
    expect(support.querySelector('[data-dropped]')?.textContent).toBe('7');
    expect(support.textContent).toContain('5s ago');
    expect(support.textContent).toContain('12');
    expect(support.textContent).toContain('25.0%');
    expect(support.querySelector('a[href="#/traces?agent=a1"]')).not.toBeNull();
    const billing = fleetRow(c, 'Billing bot')!;
    expect(billing.querySelector('.status-pill.pill-ok')?.textContent).toBe('healthy');
    expect(billing.querySelector('[data-dropped]')?.textContent).toBe('—');
  });

  it('renders a single-bucket series as a point', async () => {
    const w = chartWindow('24h', NOW);
    daemon([rollup(w.to - HOUR, 'a1', 'runs', 3), rollup(w.to - HOUR, 'a1', 'p95_latency_ms', 900)]);
    const c = render(<MonitoringScreen />);
    await waitFor(() => drawn(c, 'Runs'));
    expect(chart(c, 'Runs')!.querySelector('circle.tsc-point[data-series="ok"]')).not.toBeNull();
    expect(chart(c, 'Latency p95')!.querySelector('circle.tsc-point[data-series="a1"]')).not.toBeNull();
  });

  it('draws per-agent p95 and error rate as one unsummed series per agent', async () => {
    const w = chartWindow('24h', NOW);
    const t = w.to - HOUR;
    daemon([
      rollup(t, 'a1', 'runs', 4),
      rollup(t, 'a2', 'runs', 2),
      rollup(t, 'a1', 'p95_latency_ms', 900),
      rollup(t, 'a2', 'p95_latency_ms', 400),
      rollup(t, 'a1', 'error_rate', 0.5),
      rollup(t, 'a2', 'error_rate', 0.25),
    ]);
    const c = render(<MonitoringScreen />);
    await waitFor(() => drawn(c, 'Latency p95'));
    for (const title of ['Latency p95', 'Error rate']) {
      const points = chart(c, title)!.querySelectorAll('circle.tsc-point');
      expect([...points].map((p) => p.getAttribute('data-series'))).toEqual(['a1', 'a2']);
      // Unsummed: the two agents sit at different heights in the one bucket.
      expect(points[0]!.getAttribute('cy')).not.toBe(points[1]!.getAttribute('cy'));
      expect(chart(c, title)!.querySelector('.tsc-legend')?.textContent).toBe('Support botBilling bot');
    }
  });

  it('notes the agents left off a per-agent chart past five', async () => {
    const w = chartWindow('24h', NOW);
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'];
    daemon(ids.flatMap((id, i) => [rollup(w.from, id, 'runs', i + 1), rollup(w.from, id, 'p95_latency_ms', 100)]));
    const c = render(<MonitoringScreen />);
    await waitFor(() => drawn(c, 'Latency p95'));
    expect(chart(c, 'Latency p95')!.querySelectorAll('circle.tsc-point')).toHaveLength(5);
    expect(chart(c, 'Latency p95')!.querySelector('.mon-chart-note')?.textContent).toContain('2 more agents not shown');
  });

  it('metric cards show the window figures with the change against the previous window', async () => {
    const w = chartWindow('24h', NOW);
    const span = w.to - w.from;
    daemon([
      rollup(w.from, 'a1', 'runs', 10),
      rollup(w.from, 'a1', 'errors', 1),
      rollup(w.from, 'a1', 'cost_usd', 0.5),
      rollup(w.from, 'a1', 'p95_latency_ms', 800),
      rollup(w.from + HOUR, 'a1', 'runs', 20),
      rollup(w.from + HOUR, 'a1', 'errors', 2),
      rollup(w.from + HOUR, 'a1', 'cost_usd', 0.5),
      rollup(w.from + HOUR, 'a1', 'p95_latency_ms', 1100),
      // The previous window: 15 runs, 3 errors, $2, p95 2s.
      rollup(w.from - span, 'a1', 'runs', 15),
      rollup(w.from - span, 'a1', 'errors', 3),
      rollup(w.from - span, 'a1', 'cost_usd', 2),
      rollup(w.from - span, 'a1', 'p95_latency_ms', 2000),
    ]);
    const c = render(<MonitoringScreen />);
    await waitFor(() => drawn(c, 'Runs'));
    const card = (label: string) =>
      [...c.querySelectorAll('.metric-card')].find((el) => el.querySelector('.metric-label')?.textContent === label)!;
    expect(card('Runs').querySelector('.metric-value')?.textContent).toBe('30');
    expect(card('Runs').querySelector('.metric-delta')?.textContent).toContain('up 100% vs previous 24h');
    expect(card('Error rate').querySelector('.metric-value')?.textContent).toBe('10.0%');
    expect(card('Error rate').querySelector('.metric-delta')?.textContent).toContain('down 10 pp vs previous 24h');
    expect(card('Error rate').querySelector('.metric-delta')?.getAttribute('data-tone')).toBe('good');
    expect(card('p95 latency').querySelector('.metric-value')?.textContent).toBe('1.0s');
    expect(card('p95 latency').textContent).toContain('runs-weighted');
    expect(card('Cost').querySelector('.metric-value')?.textContent).toBe('$1.00');
    expect(card('Cost').querySelector('.metric-delta')?.getAttribute('data-tone')).toBe('good');
    expect(card('Runs').querySelector('svg.metric-sparkline')).not.toBeNull();
    // The charts draw the current window only: the previous window's bucket is outside it.
    expect(chart(c, 'Runs')!.querySelectorAll('polyline.tsc-line[data-series="ok"]')).toHaveLength(1);
  });

  it('shows no delta without a previous window', async () => {
    const w = chartWindow('24h', NOW);
    daemon([rollup(w.from, 'a1', 'runs', 10)]);
    const c = render(<MonitoringScreen />);
    await waitFor(() => drawn(c, 'Runs'));
    expect(c.querySelector('.metric-delta')).toBeNull();
  });

  it('shows card skeletons while the charts load, and an empty state for an empty window', async () => {
    const { fetchFn } = daemon();
    let release: () => void = () => undefined;
    const stalled = new Promise<void>((r) => (release = r));
    const passthrough = fetchFn.getMockImplementation()!;
    fetchFn.mockImplementation(async (input) => {
      if (String(input).includes('granularity=')) await stalled;
      return passthrough(input);
    });
    const c = render(<MonitoringScreen />);
    await waitFor(() => fleetRow(c, 'Support bot') !== undefined);
    expect(c.querySelector('.mon-charts[aria-busy="true"] [role="status"]')?.textContent).toBe('Loading charts');
    expect(c.querySelectorAll('.mon-chart .skeleton').length).toBe(5);
    expect(c.querySelectorAll('.metric-card[aria-busy="true"]').length).toBe(4);
    release();
    await waitFor(() => c.querySelector('.mon-charts-empty') !== null);
    expect(c.querySelector('.mon-charts-empty')?.textContent).toContain('No runs in this window');
  });

  it('offers an agent= id the fleet does not list in the agent select', async () => {
    window.history.replaceState(null, '', '/#/monitoring?agent=ghost-agent');
    daemon();
    const c = render(<MonitoringScreen />);
    await waitFor(() => fleetRow(c, 'Support bot') !== undefined);
    const select = c.querySelector('.mon-agent-filter select') as HTMLSelectElement;
    expect(select.value).toBe('ghost-agent');
    expect([...select.options].map((o) => o.value)).toEqual(['', 'a1', 'a2', 'ghost-agent']);
  });

  it('navigates to Traces with the clicked bucket as from/to, plus the agent when filtered', async () => {
    window.history.replaceState(null, '', '/#/monitoring?agent=a1');
    const w = chartWindow('24h', NOW);
    daemon([rollup(w.from, 'a1', 'runs', 1)]);
    const c = render(<MonitoringScreen />);
    await waitFor(() => drawn(c, 'Runs'));
    const plot = chart(c, 'Runs')!.querySelector('rect.tsc-plot')!;
    // jsdom lays the 600 px chart out at x = 0; the plot starts after the 48 px y-axis gutter.
    act(() => plot.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 50 })));
    expect(window.location.hash).toBe(`#/traces?from=${w.from}&to=${w.from + HOUR}&agent=a1`);
  });

  it('keeps window and agent in the URL and queries with them', async () => {
    window.history.replaceState(null, '', '/#/monitoring?window=7d&agent=a1');
    const { calls } = daemon();
    const c = render(<MonitoringScreen />);
    await waitFor(() => calls('/api/v1/insights').some((u) => u.includes('granularity=day')));
    const chartCall = calls('/api/v1/insights').find((u) => u.includes('granularity=day'))!;
    expect(chartCall).toContain('agent_id=a1');
    // One query reaches back a second window span, for the metric cards' change.
    const week = chartWindow('7d', NOW);
    const q = new URL(chartCall, 'http://x').searchParams;
    expect(Number(q.get('since'))).toBe(week.from - (week.to - week.from));
    expect(Number(q.get('until'))).toBe(week.to);
    const pressed = () => c.querySelector('.mon-windows [aria-pressed="true"]')?.textContent;
    expect(pressed()).toBe('7d');

    const button = (label: string) =>
      [...c.querySelectorAll('.mon-windows button')].find((b) => b.textContent === label) as HTMLButtonElement;
    act(() => button('1h').click());
    expect(window.location.hash).toBe('#/monitoring?window=1h&agent=a1');
    await waitFor(() => pressed() === '1h');
    await waitFor(() => calls('/api/v1/insights').some((u) => u.includes('granularity=hour') && u.includes('agent_id=a1')));
    act(() => button('24h').click());
    expect(window.location.hash).toBe('#/monitoring?agent=a1');
  });

  it('polls the fleet and charts every 15 s', async () => {
    const { calls } = daemon();
    const c = render(<MonitoringScreen />);
    await waitFor(() => fleetRow(c, 'Support bot') !== undefined);
    const agents = calls('/api/v1/agents').length;
    const insights = calls('/api/v1/insights').length;
    await act(async () => {
      vi.advanceTimersByTime(MONITORING_POLL_MS - 1);
    });
    expect(calls('/api/v1/agents').length).toBe(agents);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await waitFor(() => calls('/api/v1/agents').length === agents + 1);
    expect(calls('/api/v1/insights').length).toBe(insights + 2);
  });

  it('shows the daemon-down state with the URL kept and recovers in place', async () => {
    window.history.replaceState(null, '', '/#/monitoring?window=7d');
    const { state } = daemon();
    state.down = true;
    const c = render(<MonitoringScreen />);
    await waitFor(() => c.textContent!.includes('lousho observe start'));
    expect(window.location.hash).toBe('#/monitoring?window=7d');

    state.down = false;
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    await waitFor(() => fleetRow(c, 'Support bot') !== undefined);
    expect(c.textContent).not.toContain('lousho observe start');
    expect(window.location.hash).toBe('#/monitoring?window=7d');
  });
});
