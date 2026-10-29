import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ScreenHeader renders inline here (no shell host); its live run status reads the app state.
vi.mock('../../../state/AppState', () => ({ useAppState: () => ({ runStatus: null }) }));

import { ThreadsScreen } from '../ThreadsScreen';
import { formatThreadsQuery, parseThreadsQuery } from '../threadsUrl';
import { render } from '../../../ui/__tests__/render';
import { ToastProvider } from '../../../ui/Toast';
import type { ObserveObservationRow, ObserveSessionRow, ObserveTraceDetail, ObserveTraceRow } from '../../../observe/types';

const NOW = new Date(2026, 9, 25, 15, 30, 0).getTime();

const SESSION: ObserveSessionRow = {
  session_id: 'sess-abcdef123456',
  agent_id: 'agent-1',
  agent_name: 'support-bot',
  status: 'active',
  started_at: NOW - 120_000,
  ended_at: NOW - 20_000,
  traces: 2,
  input_tokens: 200,
  output_tokens: 50,
  cost_usd: 0.004,
  last_input_preview: 'Can I get a refund?',
};

const TURN_1: ObserveTraceRow = {
  trace_id: 'trace-1',
  name: 'answer',
  agent_id: 'agent-1',
  agent_name: 'support-bot',
  session_id: SESSION.session_id,
  start: NOW - 120_000,
  end: NOW - 118_000,
  status: 'ok',
  observations: 3,
  generations: 1,
  tools: 0,
  errors: 0,
  input_tokens: 100,
  output_tokens: 30,
  cost_usd: 0.002,
  model: 'gpt-4o-mini',
  error_message: null,
  input_preview: 'Where is my order?',
  output_preview: 'It ships tomorrow.',
};

const TURN_2: ObserveTraceRow = {
  ...TURN_1,
  trace_id: 'trace-2',
  start: NOW - 30_000,
  end: NOW - 20_000,
  status: 'error',
  errors: 1,
  input_preview: 'Can I get a refund?',
  output_preview: null,
  error_message: 'Tool refund_lookup timed out',
};

/** A root observation for a turn's trace detail (the full I/O the 200-char previews cut). */
function rootRow(traceId: string, over: Partial<ObserveObservationRow> = {}): ObserveObservationRow {
  return {
    obs_id: `${traceId}-root`, trace_id: traceId, session_id: SESSION.session_id, agent_id: 'agent-1', parent_obs_id: null,
    kind: 'agent', name: 'answer', start: NOW - 120_000, end: NOW - 118_000, status: 'ok', input: null, output: null,
    model: null, usage_input_tokens: null, usage_output_tokens: null, usage_cached_tokens: null, usage_reasoning_tokens: null,
    cost_usd: null, cost_partial: null, usage_estimated: null, truncated: false, attrs: null, ...over,
  };
}

const LONG_ASK = `Where is my order? ${'Details: order 42, placed last week. '.repeat(8)}`;
const FULL_INPUT = JSON.stringify([{ role: 'system', content: 'You are a support bot.' }, { role: 'user', content: LONG_ASK }]);

/** Trace details by id; a missing id is the daemon's 404, a `500` value a failed fetch. */
let details: Record<string, ObserveTraceDetail | 500> = {};

let fetchFn: ReturnType<typeof vi.fn<[RequestInfo | URL], Promise<Response>>>;

/** Daemon stub: healthy, one agent, one session with two turns; any other session id is a 404. */
function stubDaemon() {
  fetchFn = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://x');
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.pathname.endsWith('/health')) return json({ service: 'lousho-observe', ok: true });
    if (url.pathname.includes('/api/v1/agents')) return json({ agents: [{ agent_id: 'agent-1', name: 'support-bot', project: 'shop' }] });
    if (url.pathname.endsWith(`/api/v1/sessions/${SESSION.session_id}`)) return json({ session: SESSION, traces: [TURN_1, TURN_2] });
    const detail = /\/api\/v1\/traces\/([^/]+)$/.exec(url.pathname);
    if (detail) {
      const d = details[decodeURIComponent(detail[1])];
      if (d === 500) return json({ error: 'boom' }, 500);
      return d ? json(d) : json({ error: 'No trace', code: 'LOUSHO_REQUEST_INVALID' }, 404);
    }
    if (url.pathname.includes('/api/v1/sessions/')) return json({ error: 'No session', code: 'LOUSHO_REQUEST_INVALID' }, 404);
    return json({ sessions: [SESSION], total: 1, limit: 50, offset: 0 });
  });
  vi.stubGlobal('fetch', fetchFn);
}

/** The session-list requests the screen sent, as parsed query strings. */
const listRequests = () =>
  fetchFn.mock.calls
    .map(([input]) => new URL(String(input), 'http://x'))
    .filter((u) => u.pathname.endsWith('/api/v1/sessions'))
    .map((u) => u.searchParams);

async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      // hashchange is dispatched as a task, so wait one macrotask, not just microtasks.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mountAt(hash: string) {
  window.history.replaceState(null, '', `/${hash}`);
  const container = render(
    <ToastProvider>
      <ThreadsScreen />
    </ToastProvider>,
  );
  await flush();
  return container;
}

beforeEach(() => {
  details = {};
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  stubDaemon();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('threadsUrl', () => {
  it('round-trips agent, status, window and offset, and leaves the defaults out', () => {
    expect(formatThreadsQuery(parseThreadsQuery(new URLSearchParams('')))).toBe('');
    const qs = 'agent=agent-1&status=active&from=10&to=20&offset=50';
    expect(formatThreadsQuery(parseThreadsQuery(new URLSearchParams(qs)))).toBe(`?${qs}`);
    expect(parseThreadsQuery(new URLSearchParams('from=20&to=10&offset=x'))).toEqual({ offset: 0 });
  });
});

describe('ThreadsScreen list', () => {
  it('renders the sessions from the API with their totals', async () => {
    const container = await mountAt('#/threads');
    expect(window.location.hash).toBe('#/threads');
    const rows = container.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.textContent).toContain('sess-abcdef1');
    expect(row.textContent).toContain('support-bot');
    expect(row.querySelector('[title="Can I get a refund?"]')).not.toBeNull();
    expect(row.querySelector('.status-pill')?.textContent).toContain('active');
    expect(row.textContent).toContain('250');
    expect(row.textContent).toContain('$0.0040');
    const last = listRequests().at(-1)!;
    expect(last.get('limit')).toBe('50');
    expect(last.get('offset')).toBe('0');
  });

  it('reproduces the URL filters on load', async () => {
    const container = await mountAt('#/threads?agent=agent-1&status=interrupted&from=1000&to=2000&offset=50');
    const last = listRequests().at(-1)!;
    expect(last.get('agent_id')).toBe('agent-1');
    expect(last.get('status')).toBe('interrupted');
    expect(last.get('from')).toBe('1000');
    expect(last.get('to')).toBe('2000');
    expect(last.get('offset')).toBe('50');
    const statusBtn = [...container.querySelectorAll('.facet-btn')].find((b) => b.textContent?.startsWith('Status'));
    expect(statusBtn?.querySelector('.facet-count')?.textContent).toBe('1');
    const custom = [...container.querySelectorAll('.seg-btn')].find((b) => b.textContent === 'Custom');
    expect(custom?.getAttribute('aria-pressed')).toBe('true');
  });

  it('offers the ended status the idle sweep writes', async () => {
    const container = await mountAt('#/threads?status=ended');
    expect(listRequests().at(-1)!.get('status')).toBe('ended');
    const statusBtn = [...container.querySelectorAll<HTMLButtonElement>('.facet-btn')].find((b) => b.textContent?.startsWith('Status'))!;
    act(() => statusBtn.click());
    const options = [...container.querySelectorAll('.facet-pop .facet-opt')].map((o) => o.textContent);
    expect(options).toEqual(['active', 'ended', 'interrupted']);
  });

  it('opening a row navigates to #/threads/:sessionId', async () => {
    const container = await mountAt('#/threads?status=active');
    const row = container.querySelector<HTMLTableRowElement>('tbody tr[data-row-index="0"]')!;
    row.focus();
    act(() => {
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await flush();
    expect(window.location.hash).toBe(`#/threads/${SESSION.session_id}`);
  });
});

describe('ThreadsScreen thread', () => {
  it('renders each turn as Input and Output MessageViews, oldest first, each linking to its trace', async () => {
    const container = await mountAt(`#/threads/${SESSION.session_id}`);
    const turns = [...container.querySelectorAll('.thread-turn')];
    expect(turns).toHaveLength(2);
    // Turn 1: an input and an output message.
    expect(turns[0].querySelectorAll('section.mv')).toHaveLength(2);
    expect(turns[0].textContent).toContain('Where is my order?');
    expect(turns[0].textContent).toContain('It ships tomorrow.');
    // Turn 2 failed: its input message, then the error text in the danger style.
    expect(turns[1].querySelectorAll('section.mv')).toHaveLength(1);
    expect(turns[1].querySelector('.thread-error')?.textContent).toContain('Tool refund_lookup timed out');
    expect(turns[1].querySelector('.status-pill')?.textContent).toContain('error');
    const links = turns.map((t) => [...t.querySelectorAll('a')].find((a) => a.textContent === 'Open trace')?.getAttribute('href'));
    expect(links).toEqual(['#/traces/trace-1', '#/traces/trace-2']);
  });

  it('list -> thread -> trace: Back to threads keeps the list query', async () => {
    await mountAt('#/threads?status=active');
    window.history.replaceState(null, '', `/#/threads/${SESSION.session_id}`);
    const container = render(
      <ToastProvider>
        <ThreadsScreen />
      </ToastProvider>,
    );
    await flush();
    // The header's way back is named "Back to threads", like the empty state's.
    const back = container.querySelector('.thread-back');
    expect(back?.getAttribute('aria-label') ?? back?.textContent?.trim()).toBe('Back to threads');
    expect(back?.getAttribute('href')).toBe('#/threads?status=active');
  });

  it('an unknown session shows the empty state with a way back', async () => {
    const container = await mountAt('#/threads/nope');
    expect(container.querySelector('.empty-state-title')?.textContent).toBe('Thread not found');
    const back = container.querySelector('.empty-state a');
    expect(back?.textContent).toBe('Back to threads');
    expect(container.querySelector('.thread-turn')).toBeNull();
  });
});

/** The trace-detail requests the screen sent, by trace id. */
const detailRequests = () =>
  fetchFn.mock.calls
    .map(([input]) => new URL(String(input), 'http://x').pathname)
    .flatMap((p) => /\/api\/v1\/traces\/([^/]+)$/.exec(p)?.[1] ?? []);

describe('ThreadsScreen thread full turns', () => {
  it("renders each turn's full root input/output from its trace detail as message bubbles", async () => {
    details = {
      'trace-1': { trace_id: 'trace-1', observations: [rootRow('trace-1', { input: FULL_INPUT, output: 'It ships tomorrow, by noon.' })], scores: [] },
      'trace-2': { trace_id: 'trace-2', observations: [rootRow('trace-2', { input: 'Can I get a refund? (full)', status: 'error' })], scores: [] },
    };
    const container = await mountAt(`#/threads/${SESSION.session_id}`);
    const turns = [...container.querySelectorAll('.thread-turn')];
    expect(detailRequests().sort()).toEqual(['trace-1', 'trace-2']);
    const bubbles = [...turns[0].querySelectorAll('.mv-bubble')].map((b) => b.getAttribute('data-role'));
    expect(bubbles).toEqual(['system', 'user']);
    expect(turns[0].textContent).toContain(LONG_ASK.trim());
    expect(turns[0].textContent).toContain('It ships tomorrow, by noon.');
    expect(turns[0].querySelector('.thread-turn-note')).toBeNull();
    // An error turn keeps the error in place of the output, with the full input.
    expect(turns[1].textContent).toContain('Can I get a refund? (full)');
    expect(turns[1].querySelector('.thread-error')?.textContent).toContain('Tool refund_lookup timed out');
  });

  it("labels a root the recorder truncated", async () => {
    details = { 'trace-1': { trace_id: 'trace-1', observations: [rootRow('trace-1', { input: 'cut off', output: 'x', truncated: true })], scores: [] } };
    const container = await mountAt(`#/threads/${SESSION.session_id}`);
    const turn = container.querySelectorAll('.thread-turn')[0];
    expect(turn.textContent).toContain('cut off');
    expect(turn.querySelector('.thread-turn-note')?.textContent).toMatch(/truncated when recorded/i);
  });

  it('falls back to the labelled preview when the detail fetch fails or the trace is gone', async () => {
    details = { 'trace-1': 500 };
    const container = await mountAt(`#/threads/${SESSION.session_id}`);
    const turns = [...container.querySelectorAll('.thread-turn')];
    for (const turn of turns) expect(turn.querySelector('.thread-turn-note')?.textContent).toContain('Preview (truncated)');
    expect(turns[0].textContent).toContain('Where is my order?');
    expect(turns[0].textContent).toContain('It ships tomorrow.');
  });

  it('fetches a turn only once it nears the viewport', async () => {
    const observers: { cb: IntersectionObserverCallback; els: Element[]; options?: IntersectionObserverInit }[] = [];
    class FakeIO {
      private entry: (typeof observers)[number];
      constructor(cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        this.entry = { cb, els: [], options };
        observers.push(this.entry);
      }
      observe(el: Element) { this.entry.els.push(el); }
      disconnect() { this.entry.els = []; }
      unobserve() {}
      takeRecords() { return []; }
    }
    vi.stubGlobal('IntersectionObserver', FakeIO);
    details = { 'trace-1': { trace_id: 'trace-1', observations: [rootRow('trace-1', { input: FULL_INPUT, output: 'ok' })], scores: [] } };
    const container = await mountAt(`#/threads/${SESSION.session_id}`);
    expect(detailRequests()).toEqual([]);
    expect(container.querySelectorAll('.thread-turn')[0].querySelector('.thread-turn-note')?.textContent).toContain('Preview (truncated)');
    expect(observers[0].options?.rootMargin).toBeTruthy();
    const first = observers.find((o) => o.els[0] === container.querySelectorAll('.thread-turn')[0])!;
    act(() => first.cb([{ isIntersecting: true, target: first.els[0] } as IntersectionObserverEntry], first as never));
    await flush();
    expect(detailRequests()).toEqual(['trace-1']);
    expect(container.querySelectorAll('.thread-turn')[0].querySelectorAll('.mv-bubble')).toHaveLength(2);
  });
});

describe('ThreadsScreen thread layout', () => {
  it('shows the thread header card with its totals and numbers each turn on the timeline', async () => {
    const container = await mountAt(`#/threads/${SESSION.session_id}`);
    const header = container.querySelector('.thread-header')!;
    expect(header.querySelector('h2')?.textContent).toBe('support-bot');
    expect(header.querySelector('.status-pill')?.textContent).toContain('active');
    expect(header.textContent).toContain('2 turns');
    expect(header.textContent).toContain('250 tokens');
    expect(header.textContent).toContain('$0.0040');
    const dots = [...container.querySelectorAll('.thread-turn-dot')].map((d) => d.textContent);
    expect(dots).toEqual(['1', '2']);
    expect(container.querySelectorAll('.thread-turn')[1].getAttribute('data-status')).toBe('error');
  });

  it('clamps an overflowing message behind Show more / Show less, with the full text still in the DOM', async () => {
    // jsdom has no layout: every .mv-body reports content taller than its clamped box.
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('mv-body') ? 900 : 0;
    });
    const client = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('mv-body') ? 260 : 0;
    });
    try {
      details = { 'trace-1': { trace_id: 'trace-1', observations: [rootRow('trace-1', { input: 'ask', output: `${'line\n'.repeat(40)}the end` })], scores: [] } };
      const container = await mountAt(`#/threads/${SESSION.session_id}`);
      const turn = container.querySelectorAll('.thread-turn')[0];
      const toggle = turn.querySelector<HTMLButtonElement>('button[aria-label="Show more of the output"]')!;
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(toggle.closest('.thread-clamp')?.getAttribute('data-expanded')).toBe('false');
      expect(turn.textContent).toContain('the end');
      act(() => toggle.click());
      const less = turn.querySelector<HTMLButtonElement>('button[aria-label="Show less of the output"]')!;
      expect(less.getAttribute('aria-expanded')).toBe('true');
      expect(less.textContent).toBe('Show less');
      expect(less.closest('.thread-clamp')?.getAttribute('data-expanded')).toBe('true');
    } finally {
      scroll.mockRestore();
      client.mockRestore();
    }
  });

  it('shows no toggle when a message fits', async () => {
    const container = await mountAt(`#/threads/${SESSION.session_id}`);
    expect(container.querySelector('.thread-clamp-toggle')).toBeNull();
  });

  it('shows skeletons, not text, while the thread loads', async () => {
    fetchFn.mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://x');
      if (url.pathname.endsWith('/health')) return new Response(JSON.stringify({ service: 'lousho-observe', ok: true }));
      return new Promise<Response>(() => undefined);
    });
    const container = await mountAt(`#/threads/${SESSION.session_id}`);
    const loading = container.querySelector('.thread-loading')!;
    expect(loading.getAttribute('role')).toBe('status');
    expect(loading.querySelectorAll('.skeleton').length).toBeGreaterThan(3);
    // three skeleton turn cards; the only "Loading thread..." text is the visually-hidden status
    expect(loading.querySelectorAll('.thread-turn-card')).toHaveLength(3);
    const visibleText = [...loading.querySelectorAll('p')].map((p) => p.textContent).join('');
    expect(visibleText).toBe('');
    expect(loading.querySelector('.visually-hidden')?.textContent).toBe('Loading thread...');
  });
});

describe('ThreadsScreen list layout', () => {
  it('renders the thread cell (last input over the session id) and last activity as relative time', async () => {
    const container = await mountAt('#/threads');
    const row = container.querySelector('tbody tr')!;
    expect(row.querySelector('.threads-name-title')?.textContent).toBe('Can I get a refund?');
    expect(row.querySelector('.threads-name-id')?.textContent).toBe(SESSION.session_id);
    const activity = [...row.querySelectorAll('.threads-num')].find((c) => c.textContent?.endsWith('ago'));
    expect(activity?.textContent).toBe('20s ago');
    expect(activity?.getAttribute('title')).toMatch(/^Started .* · last activity /);
  });

  it('Refresh re-fetches the list', async () => {
    const container = await mountAt('#/threads');
    const before = listRequests().length;
    const refresh = container.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!;
    act(() => refresh.click());
    await flush();
    expect(listRequests().length).toBe(before + 1);
  });
});
