import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThreadsScreen } from '../ThreadsScreen';
import { formatThreadsQuery, parseThreadsQuery } from '../threadsUrl';
import { render } from '../../../ui/__tests__/render';
import type { ObserveSessionRow, ObserveTraceRow } from '../../../observe/types';

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

let fetchFn: ReturnType<typeof vi.fn<[RequestInfo | URL], Promise<Response>>>;

/** Daemon stub: healthy, one agent, one session with two turns; any other session id is a 404. */
function stubDaemon() {
  fetchFn = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://x');
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.pathname.endsWith('/health')) return json({ service: 'lousho-observe', ok: true });
    if (url.pathname.includes('/api/v1/agents')) return json({ agents: [{ agent_id: 'agent-1', name: 'support-bot', project: 'shop' }] });
    if (url.pathname.endsWith(`/api/v1/sessions/${SESSION.session_id}`)) return json({ session: SESSION, traces: [TURN_1, TURN_2] });
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
  const container = render(<ThreadsScreen />);
  await flush();
  return container;
}

beforeEach(() => {
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
    const container = render(<ThreadsScreen />);
    await flush();
    const back = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('Back to threads'));
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
