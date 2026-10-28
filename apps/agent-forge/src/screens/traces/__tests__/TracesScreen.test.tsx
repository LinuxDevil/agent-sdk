import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TracesScreen } from '../TracesScreen';
import { render } from '../../../ui/__tests__/render';
import type { ObserveTraceRow } from '../../../observe/types';

const NOW = new Date(2026, 9, 25, 15, 30, 0).getTime();

const TRACE_OK: ObserveTraceRow = {
  trace_id: 'trace-ok',
  name: 'answer',
  agent_id: 'agent-1',
  agent_name: 'support-bot',
  session_id: null,
  start: NOW - 60_000,
  end: NOW - 58_800,
  status: 'ok',
  observations: 3,
  generations: 1,
  tools: 1,
  errors: 0,
  input_tokens: 120,
  output_tokens: 30,
  cost_usd: 0.0021,
  model: 'gpt-4o-mini',
  error_message: null,
  input_preview: 'Where is my order?',
  output_preview: 'It ships tomorrow.',
};

const TRACE_ERR: ObserveTraceRow = {
  ...TRACE_OK,
  trace_id: 'trace-err',
  name: 'refund',
  start: NOW - 30_000,
  end: NOW - 25_000,
  status: 'error',
  errors: 1,
  error_message: 'Tool refund_lookup timed out',
  output_preview: null,
};

let fetchFn: ReturnType<typeof vi.fn<[RequestInfo | URL], Promise<Response>>>;

/** Daemon stub: healthy, one agent, and the two traces above for any list query. */
function stubDaemon() {
  fetchFn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.endsWith('/health')) return json({ service: 'lousho-observe', ok: true });
    if (url.includes('/api/v1/agents')) return json({ agents: [{ agent_id: 'agent-1', name: 'support-bot', project: 'shop' }] });
    if (url.includes('/api/v1/traces/')) return json({ trace_id: 'x', observations: [], scores: [] });
    return json({ traces: [TRACE_ERR, TRACE_OK], total: 2, limit: 50, offset: 0 });
  });
  vi.stubGlobal('fetch', fetchFn);
}

/** The list requests the screen sent, as parsed query strings. */
const listRequests = () =>
  fetchFn.mock.calls
    .map(([input]) => new URL(String(input), 'http://x'))
    .filter((u) => u.pathname.endsWith('/api/v1/traces'))
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
  const container = render(<TracesScreen />);
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

describe('TracesScreen', () => {
  it('reproduces status and time range filters from the URL on load', async () => {
    const from = NOW - 3_600_000;
    const to = NOW - 600_000;
    const container = await mountAt(`#/traces?status=error&from=${from}&to=${to}`);
    const last = listRequests().at(-1)!;
    expect(last.get('status')).toBe('error');
    expect(last.get('from')).toBe(String(from));
    expect(last.get('to')).toBe(String(to));
    expect(last.get('limit')).toBe('50');
    // The status facet shows one selection and the picker shows the absolute window as Custom.
    const statusBtn = [...container.querySelectorAll('.facet-btn')].find((b) => b.textContent?.startsWith('Status'));
    expect(statusBtn?.querySelector('.facet-count')?.textContent).toBe('1');
    const custom = [...container.querySelectorAll('.seg-btn')].find((b) => b.textContent === 'Custom');
    expect(custom?.getAttribute('aria-pressed')).toBe('true');
  });

  it('shows the error_message of a failed run in its row, in the danger style', async () => {
    const container = await mountAt('#/traces');
    const row = [...container.querySelectorAll('tbody tr')].find((tr) => tr.textContent?.includes('refund'))!;
    const error = row.querySelector('.traces-error');
    expect(error?.textContent).toBe('Tool refund_lookup timed out');
    expect(error?.getAttribute('title')).toBe('Tool refund_lookup timed out');
    // The ok row has no error text.
    const ok = [...container.querySelectorAll('tbody tr')].find((tr) => tr.textContent?.includes('answer'))!;
    expect(ok.querySelector('.traces-error')).toBeNull();
    // Started has seconds; previews keep the full text in a title.
    expect(row.textContent).toContain('15:29:30');
    expect(ok.querySelector('[title="Where is my order?"]')).not.toBeNull();
  });

  it('sorting by duration requests sort=duration&order=desc and writes it to the URL', async () => {
    const container = await mountAt('#/traces');
    // A bare #/traces stays bare, and asks for the rolling 24h window.
    expect(window.location.hash).toBe('#/traces');
    const first = listRequests().at(-1)!;
    expect(first.get('from')).toBe(String(NOW - 86_400_000));
    expect(first.get('sort')).toBeNull();

    const button = [...container.querySelectorAll('th button.dt-sort')].find((b) => b.textContent?.startsWith('Duration'))!;
    act(() => (button as HTMLButtonElement).click());
    await flush();
    const last = listRequests().at(-1)!;
    expect(last.get('sort')).toBe('duration');
    expect(last.get('order')).toBe('desc');
    expect(window.location.hash).toBe('#/traces?sort=duration&order=desc');
  });

  it('Enter on a focused row opens #/traces/:id', async () => {
    const container = await mountAt('#/traces?status=error');
    const row = container.querySelector<HTMLTableRowElement>('tbody tr[data-row-index="0"]')!;
    row.focus();
    act(() => {
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await flush();
    expect(window.location.hash).toBe('#/traces/trace-err');
  });
});
