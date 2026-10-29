import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { render } from '../../../ui/__tests__/render';
import { ToastProvider } from '../../../ui/Toast';
import type { ObserveObservationRow, ObserveScoreRow, ObserveTraceDetail } from '../../../observe/types';
import { TraceScreen } from '../TraceScreen';
import type { ScreenHeaderProps } from '../../../shell/ScreenHeader';

// The shell's header needs the app state; here it renders its props in place.
vi.mock('../../../shell/ScreenHeader', () => ({
  ScreenHeader: ({ title, description, actions }: ScreenHeaderProps) => (
    <header className="test-screen-header">
      <h1>{title}</h1>
      <p>{description}</p>
      {actions}
    </header>
  ),
}));

const T0 = 1_700_000_000_000;

function obs(over: Partial<ObserveObservationRow> & { obs_id: string }): ObserveObservationRow {
  return {
    trace_id: 't1',
    session_id: 's1',
    agent_id: 'a1',
    parent_obs_id: null,
    kind: 'span',
    name: over.obs_id,
    start: T0,
    end: T0 + 100,
    status: 'ok',
    input: null,
    output: null,
    model: null,
    usage_input_tokens: null,
    usage_output_tokens: null,
    usage_cached_tokens: null,
    usage_reasoning_tokens: null,
    cost_usd: null,
    cost_partial: null,
    usage_estimated: null,
    truncated: false,
    attrs: null,
    ...over,
  };
}

const TRACE: ObserveTraceDetail = {
  trace_id: 't1',
  observations: [
    obs({ obs_id: 'root', name: 'support run', start: T0, end: T0 + 2500 }),
    obs({
      obs_id: 'gen1',
      parent_obs_id: 'root',
      kind: 'generation',
      name: 'llm call',
      start: T0 + 100,
      end: T0 + 900,
      model: 'gpt-4o-mini',
      usage_input_tokens: 1200,
      usage_output_tokens: 34,
      cost_usd: 0.0123,
    }),
    obs({ obs_id: 'tool1', parent_obs_id: 'gen1', kind: 'tool', name: 'get_weather', start: T0 + 950, end: T0 + 1500 }),
  ],
  scores: [],
};

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A stand-in daemon behind the `/observe` proxy; `down` makes every request fail like a refused connection. */
function daemon(opts: { trace?: ObserveTraceDetail; onScore?: Handler } = {}) {
  const state = { down: false, trace: opts.trace, scores: [] as ObserveScoreRow[] };
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (state.down) throw new TypeError('fetch failed');
    const url = String(input);
    if (url.startsWith('/observe/health')) return json(200, { service: 'lousho-observe', ok: true });
    if (url.startsWith('/observe/__target')) return json(200, { url: 'http://127.0.0.1:7777' });
    if (url.startsWith('/observe/api/v1/agents')) return json(200, { agents: [{ agent_id: 'a1', name: 'Support bot' }] });
    if (url.startsWith('/observe/api/v1/scores') && init?.method === 'POST') {
      if (opts.onScore) return opts.onScore(url, init);
      const body = JSON.parse(init.body as string) as { obs_id?: string; name: string; value: number; comment?: string };
      state.scores.push({
        score_id: `sc${state.scores.length + 1}`,
        trace_id: 't1',
        obs_id: body.obs_id ?? null,
        name: body.name,
        value: body.value,
        source: 'human',
        comment: body.comment ?? null,
        agent_id: 'a1',
        created_at: T0,
      });
      return json(201, { score_id: `sc${state.scores.length}` });
    }
    if (url.startsWith('/observe/api/v1/traces/')) {
      if (!state.trace || !url.endsWith(`/${state.trace.trace_id}`)) return json(404, { error: 'No trace.' });
      return json(200, { ...state.trace, scores: [...state.trace.scores, ...state.scores] });
    }
    return json(404, { error: `unexpected ${url}` });
  });
  vi.stubGlobal('fetch', fetchFn);
  return { state, fetchFn };
}

async function waitFor(check: () => boolean, timeoutMs = 2000) {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error('waitFor timed out');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

function mount(traceId = 't1', pollMs?: number) {
  return render(
    <ToastProvider>
      <TraceScreen traceId={traceId} pollMs={pollMs} />
    </ToastProvider>,
  );
}

const inspectedId = (c: HTMLElement) => (c.querySelector('.run-inspector') as HTMLElement | null)?.dataset.obsId;

beforeEach(() => {
  window.history.replaceState(null, '', '/#/traces/t1');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('TraceScreen', () => {
  it('shows the header: name, status, agent link, model, duration, tokens, cost, session link', async () => {
    daemon({ trace: TRACE });
    const c = mount();
    await waitFor(() => c.querySelector('.trace-header') !== null);
    const header = c.querySelector('.trace-header') as HTMLElement;
    expect(header.querySelector('h2')?.textContent).toBe('support run');
    expect(header.querySelector('.status-pill.pill-ok')).not.toBeNull();
    await waitFor(() => header.textContent!.includes('Support bot'));
    const agent = header.querySelector('a[href="#/traces?agent=a1"]') as HTMLAnchorElement;
    expect(agent.textContent).toBe('Support bot');
    expect(header.textContent).toContain('gpt-4o-mini');
    expect(header.textContent).toContain('2.5s');
    expect(header.textContent).toContain('1,234');
    expect(header.querySelector('a[href="#/threads/s1"]')).not.toBeNull();
    expect(header.querySelector('button[aria-label="Copy link"]')).not.toBeNull();
  });

  it('header duration for an interrupted root with no end stops at the latest child end', async () => {
    daemon({
      trace: {
        trace_id: 't1',
        observations: [
          obs({ obs_id: 'root', name: 'crashed run', start: T0, end: null, status: 'interrupted' }),
          obs({ obs_id: 'c1', parent_obs_id: 'root', start: T0 + 100, end: T0 + 4000 }),
        ],
        scores: [],
      },
    });
    const c = mount();
    await waitFor(() => c.querySelector('.trace-header') !== null);
    const header = c.querySelector('.trace-header') as HTMLElement;
    expect(header.textContent).toContain('4.0s');
    expect(header.textContent).toContain('interrupted');
  });

  it('selects the ?obs= node on load and writes ?obs= with replace on selection', async () => {
    window.history.replaceState(null, '', '/#/traces/t1?obs=tool1');
    daemon({ trace: TRACE });
    const c = mount();
    await waitFor(() => inspectedId(c) !== undefined);
    expect(inspectedId(c)).toBe('tool1');

    const before = window.history.length;
    const genRow = c.querySelector('[data-obs-id="gen1"] button.run-row-main') as HTMLButtonElement;
    act(() => genRow.click());
    expect(window.location.hash).toBe('#/traces/t1?obs=gen1');
    expect(window.history.length).toBe(before);
    await waitFor(() => inspectedId(c) === 'gen1');
    // The observe trace screen keeps the row's icon link and the header button for the selected generation;
    // the inspector drops its duplicate.
    expect(c.querySelector('.run-tree [data-obs-id="gen1"] .run-playground-link')?.getAttribute('href')).toBe('#/playground?trace=t1&fromObs=gen1');
    expect(c.querySelector('.trace-header a[href="#/playground?trace=t1&fromObs=gen1"]')).not.toBeNull();
    expect(c.querySelector('.run-inspector .run-playground-link')).toBeNull();
  });

  it('shows an EmptyState with "Back to traces" for a missing trace', async () => {
    window.history.replaceState(null, '', '/#/traces/nope');
    daemon({ trace: TRACE });
    const c = mount('nope');
    await waitFor(() => c.querySelector('.empty-state') !== null);
    expect(c.querySelector('.empty-state-title')?.textContent).toBe('Trace not found');
    const back = [...c.querySelectorAll('button')].find((b) => b.textContent === 'Back to traces') as HTMLButtonElement;
    act(() => back.click());
    expect(window.location.hash).toBe('#/traces');
  });

  it('submits feedback with POST /observe/api/v1/scores, toasts, and refetches the trace', async () => {
    window.history.replaceState(null, '', '/#/traces/t1?obs=gen1');
    const { fetchFn } = daemon({ trace: TRACE });
    const c = mount();
    await waitFor(() => inspectedId(c) === 'gen1');

    const form = c.querySelector('[data-section="feedback"] form.trace-feedback') as HTMLFormElement;
    act(() => (form.querySelector('button[aria-label="Thumbs up"]') as HTMLButtonElement).click());
    const comment = form.querySelector('textarea') as HTMLTextAreaElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(comment, 'great answer');
      comment.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => (form.querySelector('button[type="submit"]') as HTMLButtonElement).click());

    await waitFor(() => document.body.textContent!.includes('Feedback saved'));
    const post = fetchFn.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST')!;
    expect(String(post[0])).toBe('/observe/api/v1/scores');
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({
      trace_id: 't1',
      obs_id: 'gen1',
      name: 'feedback',
      value: 1,
      comment: 'great answer',
    });
    await waitFor(() => c.querySelector('[data-section="feedback"] .run-score-comment')?.textContent === 'great answer');
  });

  it('omits obs_id for root feedback and shows an error toast when the write fails', async () => {
    const { fetchFn } = daemon({ trace: TRACE, onScore: () => json(400, { error: 'bad body' }) });
    const c = mount();
    await waitFor(() => inspectedId(c) === 'root');
    const form = c.querySelector('form.trace-feedback') as HTMLFormElement;
    act(() => (form.querySelector('button[aria-label="Thumbs down"]') as HTMLButtonElement).click());
    act(() => (form.querySelector('button[type="submit"]') as HTMLButtonElement).click());
    await waitFor(() => document.body.querySelector('.toast-error') !== null);
    expect(document.body.querySelector('.toast-error')?.textContent).toContain('bad body');
    const post = fetchFn.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST')!;
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({ trace_id: 't1', name: 'feedback', value: 0 });
  });

  it('copies the full URL (with ?obs=) and toasts "Link copied"', async () => {
    window.history.replaceState(null, '', '/#/traces/t1?obs=tool1');
    daemon({ trace: TRACE });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const c = mount();
    await waitFor(() => c.querySelector('button[aria-label="Copy link"]') !== null);
    act(() => (c.querySelector('button[aria-label="Copy link"]') as HTMLButtonElement).click());
    await waitFor(() => document.body.textContent!.includes('Link copied'));
    expect(writeText).toHaveBeenCalledWith(window.location.href);
    expect(window.location.href).toContain('#/traces/t1?obs=tool1');
  });

  it('shows the daemon-down state with the URL kept, and recovers in place', async () => {
    window.history.replaceState(null, '', '/#/traces/t1?obs=gen1');
    const { state } = daemon({ trace: TRACE });
    state.down = true;
    const c = mount('t1', 30);
    await waitFor(() => c.textContent!.includes('lousho observe start'));
    expect(window.location.hash).toBe('#/traces/t1?obs=gen1');

    state.down = false;
    await waitFor(() => inspectedId(c) === 'gen1');
    expect(c.textContent).not.toContain('lousho observe start');
    expect(window.location.hash).toBe('#/traces/t1?obs=gen1');
  });

  it('sets the page header: Traces, the trace id, and a link back to the list', async () => {
    daemon({ trace: TRACE });
    const c = mount();
    await waitFor(() => c.querySelector('.trace-header') !== null);
    const header = c.querySelector('.test-screen-header') as HTMLElement;
    expect(header.querySelector('h1')?.textContent).toBe('Traces');
    expect(header.querySelector('.trace-id')?.textContent).toBe('t1');
    const back = header.querySelector('a') as HTMLAnchorElement;
    expect(back.textContent).toBe('All traces');
    expect(back.getAttribute('href')).toMatch(/^#\/traces/);
  });
});
