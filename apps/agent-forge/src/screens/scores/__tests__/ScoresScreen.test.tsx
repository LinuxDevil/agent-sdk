import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ObserveScorePassRate, ObserveScoreRow } from '../../../observe/types';
import { render } from '../../../ui/__tests__/render';
import { ScoresScreen } from '../ScoresScreen';
import { groupEvalScores, passRateSeries, traceHref, trendWindow } from '../scoresData';

const NOW = Date.UTC(2026, 9, 25, 12, 30);
const DAY = 86_400_000;

let seq = 0;
function score(over: Partial<ObserveScoreRow> & { name: string }): ObserveScoreRow {
  seq += 1;
  return {
    score_id: `s${seq}`,
    trace_id: `t${seq}`,
    obs_id: null,
    value: 1,
    source: 'eval',
    comment: null,
    agent_id: 'a1',
    created_at: NOW - DAY,
    ...over,
  };
}

const RATES: ObserveScorePassRate[] = [
  { name: 'support', count: 6, passed: 4, pass_rate: 4 / 6, avg_value: 0.67, last_ts: NOW - 1000 },
  { name: 'billing', count: 2, passed: 2, pass_rate: 1, avg_value: 1, last_ts: NOW - DAY },
];

const SUPPORT_ROWS: ObserveScoreRow[] = [
  score({ name: 'support', value: 1, created_at: NOW - 3 * DAY }),
  score({ name: 'support/tone', value: 1, created_at: NOW - 3 * DAY }),
  score({ name: 'support/refund', value: 1, created_at: NOW - 3 * DAY }),
  score({ name: 'support', value: 0, comment: 'refund', created_at: NOW - 1000, trace_id: 'trace-fail', obs_id: 'obs-9' }),
  score({ name: 'support/tone', value: 1, created_at: NOW - 1000 }),
  score({ name: 'support/refund', value: 0, comment: 'expected a refund link', created_at: NOW - 1000, trace_id: 'trace-fail' }),
];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A stand-in daemon behind `/observe`; `down` fails every request like a refused connection. */
function daemon() {
  const state = { down: false };
  const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
    if (state.down) throw new TypeError('fetch failed');
    const url = String(input);
    const q = new URL(url, 'http://x').searchParams;
    if (url.startsWith('/observe/health')) return json(200, { service: 'lousho-observe', ok: true });
    if (url.startsWith('/observe/__target')) return json(200, { url: 'http://127.0.0.1:7777' });
    if (url.startsWith('/observe/api/v1/agents')) return json(200, { agents: [{ agent_id: 'a1', name: 'Support bot' }] });
    if (url.startsWith('/observe/api/v1/scores') && q.get('aggregate') === 'eval') return json(200, { evals: RATES });
    if (url.startsWith('/observe/api/v1/scores')) return json(200, { scores: q.get('eval') === 'support' ? SUPPORT_ROWS : [] });
    return json(404, { error: `unexpected ${url}` });
  });
  vi.stubGlobal('fetch', fetchFn);
  const calls = (match: string) => fetchFn.mock.calls.map(([u]) => String(u)).filter((u) => u.includes(match));
  return { state, calls };
}

async function waitFor(check: () => boolean, turns = 50) {
  for (let i = 0; !check(); i++) {
    if (i > turns) throw new Error('waitFor gave up');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const evalRow = (c: HTMLElement, name: string) =>
  [...c.querySelectorAll('.data-table tbody tr, table tbody tr')].find((tr) =>
    tr.querySelector('.scores-toggle')?.textContent?.includes(name),
  ) as HTMLElement | undefined;
const detail = (c: HTMLElement) => c.querySelector('[data-eval]') as HTMLElement | null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(NOW);
  window.history.replaceState(null, '', '/#/evals/scores');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('scoresData', () => {
  it('splits eval-level rows from per-check groups, worst check first', () => {
    const g = groupEvalScores('support', [...SUPPORT_ROWS, score({ name: 'supportive/x' })]);
    expect(g.evalRows.map((r) => r.value)).toEqual([1, 0]);
    expect(g.checks.map((c) => [c.check, c.count, c.passRate])).toEqual([
      ['refund', 2, 0.5],
      ['tone', 2, 1],
    ]);
    expect(g.failures.map((r) => r.name)).toEqual(['support', 'support/refund']);
  });

  it('pre-aggregates the trend to one mean point per bucket', () => {
    const w = trendWindow({ preset: '7d' }, NOW);
    const t = NOW - 2 * DAY;
    const s = passRateSeries(
      [score({ name: 'e', value: 1, created_at: t }), score({ name: 'e', value: 0, created_at: t + 60_000 }), score({ name: 'e', value: null, created_at: t })],
      w,
    );
    expect(s.points).toEqual([{ t: t - (t % DAY), v: 0.5 }]);
  });

  it('links a score to its trace, and to the step when it has one', () => {
    expect(traceHref({ trace_id: 'tr 1', obs_id: null })).toBe('#/traces/tr%201');
    expect(traceHref({ trace_id: 'tr', obs_id: 'o1' })).toBe('#/traces/tr?obs=o1');
  });
});

describe('ScoresScreen', () => {
  it('lists one row per eval from the aggregate', async () => {
    const { calls } = daemon();
    const c = render(<ScoresScreen />);
    await waitFor(() => evalRow(c, 'billing') !== undefined);
    const support = evalRow(c, 'support')!;
    expect(support.textContent).toContain('66.7%');
    expect(support.textContent).toContain('6');
    expect(calls('aggregate=eval')[0]).toContain(`since=${NOW - 30 * DAY}`);
    // Nothing is expanded, so no per-eval rows are fetched.
    expect(calls('/api/v1/scores').filter((u) => !u.includes('aggregate'))).toEqual([]);
  });

  it('expands an eval into its runs, per-check pass rates and failures linking to the trace', async () => {
    const { calls } = daemon();
    const c = render(<ScoresScreen />);
    await waitFor(() => evalRow(c, 'support') !== undefined);
    act(() => (evalRow(c, 'support')!.querySelector('.scores-toggle') as HTMLButtonElement).click());
    expect(window.location.hash).toBe('#/evals/scores?open=support');
    await waitFor(() => detail(c)?.querySelector('[data-eval-runs]') != null);
    expect(calls('eval=support')[0]).toContain('limit=1000');
    const d = detail(c)!;
    expect(d.querySelector('[data-eval-runs]')!.getAttribute('data-eval-runs')).toBe('2');
    expect(d.textContent).toContain('2 runs, 50.0% passed');
    const checks = [...d.querySelectorAll('[aria-label="support checks"] tbody tr')].map((tr) => tr.textContent);
    expect(checks[0]).toContain('refund');
    expect(checks[0]).toContain('50.0%');
    expect(checks[1]).toContain('tone');
    const failures = [...d.querySelectorAll('.scores-failure')];
    expect(failures).toHaveLength(2);
    expect(failures[0]!.querySelector('a')!.getAttribute('href')).toBe('#/traces/trace-fail?obs=obs-9');
    expect(failures[1]!.querySelector('a')!.getAttribute('href')).toBe('#/traces/trace-fail');
    expect(failures[1]!.textContent).toContain('expected a refund link');
    expect(evalRow(c, 'support')!.querySelector('.scores-toggle')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('draws the trend with one point per bucket', async () => {
    window.history.replaceState(null, '', '/#/evals/scores?open=support');
    daemon();
    const c = render(<ScoresScreen />);
    await waitFor(() => detail(c)?.querySelector('.tsc-point') != null);
    // Two eval-level rows in two non-adjacent day buckets: two isolated points, no line.
    expect(detail(c)!.querySelectorAll('circle.tsc-point[data-series="pass-rate"]')).toHaveLength(2);
    expect(detail(c)!.querySelector('.tsc-line')).toBeNull();
  });

  it('round-trips the filters through the URL and queries with them', async () => {
    window.history.replaceState(null, '', '/#/evals/scores?eval=billing&agent=a1&source=human&range=7d');
    const { calls } = daemon();
    const c = render(<ScoresScreen />);
    await waitFor(() => evalRow(c, 'billing') !== undefined);
    expect(evalRow(c, 'support')).toBeUndefined();
    const call = calls('aggregate=eval').at(-1)!;
    expect(call).toContain('agent_id=a1');
    expect(call).toContain('source=human');
    expect(call).toContain(`since=${NOW - 7 * DAY}`);
    expect(c.querySelector('.time-range [aria-pressed="true"]')?.textContent).toBe('7d');

    const preset = (label: string) =>
      [...c.querySelectorAll('.time-range button')].find((b) => b.textContent === label) as HTMLButtonElement;
    act(() => preset('30d').click());
    expect(window.location.hash).toBe('#/evals/scores?eval=billing&agent=a1&source=human');
    act(() => preset('24h').click());
    expect(window.location.hash).toBe('#/evals/scores?eval=billing&agent=a1&source=human&range=24h');
    await waitFor(() => calls(`since=${NOW - DAY}`).length > 0);
  });

  it('ignores an unknown source= value', async () => {
    window.history.replaceState(null, '', '/#/evals/scores?source=bogus');
    const { calls } = daemon();
    const c = render(<ScoresScreen />);
    await waitFor(() => evalRow(c, 'billing') !== undefined);
    expect(calls('aggregate=eval')[0]).not.toContain('source=');
  });

  it('shows the daemon-down state with the URL kept and recovers in place', async () => {
    window.history.replaceState(null, '', '/#/evals/scores?range=7d&open=support');
    const { state } = daemon();
    state.down = true;
    const c = render(<ScoresScreen />);
    await waitFor(() => c.textContent!.includes('lousho observe start'));
    expect(window.location.hash).toBe('#/evals/scores?range=7d&open=support');

    state.down = false;
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    await waitFor(() => detail(c)?.querySelector('[data-eval-runs]') != null);
    expect(c.textContent).not.toContain('lousho observe start');
    expect(window.location.hash).toBe('#/evals/scores?range=7d&open=support');
  });
});
