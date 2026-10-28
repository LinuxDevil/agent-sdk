import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { QueuesScreen } from '../QueuesScreen';
import { queuePath, queuesPath } from '../queuesUrl';
import { render } from '../../../ui/__tests__/render';
import { ToastProvider } from '../../../ui/Toast';
import type { ObserveObservationRow, ObserveQueue, ObserveQueueItem } from '../../../observe/types';

const T0 = new Date(2026, 9, 20, 9, 0, 0).getTime();

const REVIEW: ObserveQueue = {
  queue_id: 'q1',
  name: 'support-review',
  rubric: [
    { name: 'helpfulness', description: 'Did it answer the question?', min: 0, max: 5 },
    { name: 'tone', min: 1, max: 3 },
  ],
  created_at: T0,
  counts: { pending: 2, done: 3, skipped: 1 },
};

const item = (n: number): ObserveQueueItem => ({
  item_id: `i${n}`,
  queue_id: 'q1',
  trace_id: `trace-${n}`,
  status: 'pending',
  reviewer: null,
  created_at: T0 + n,
  done_at: null,
});

const observation = (traceId: string): ObserveObservationRow => ({
  obs_id: `${traceId}-root`,
  trace_id: traceId,
  session_id: null,
  agent_id: null,
  parent_obs_id: null,
  kind: 'agent',
  name: `run of ${traceId}`,
  start: T0,
  end: T0 + 1000,
  status: 'ok',
  input: '"hello"',
  output: '"hi"',
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
});

type Call = { path: string; query: URLSearchParams; method: string; body: unknown };

let queues: ObserveQueue[];
let pending: ObserveQueueItem[];
let calls: Call[];
let completeStatus: number;
let down: boolean;

/** Daemon stub behind `/observe`: `q1` serves `pending` in order; completing an item drops it from the front. */
function stubDaemon() {
  queues = [REVIEW];
  pending = [item(1), item(2)];
  calls = [];
  completeStatus = 200;
  down = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (down) throw new TypeError('fetch failed');
      const url = new URL(String(input), 'http://x');
      const method = init?.method ?? 'GET';
      const p = url.pathname.replace(/^\/observe/, '');
      calls.push({ path: p, query: url.searchParams, method, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (p === '/health') return json({ service: 'lousho-observe', ok: true });
      if (p === '/__target') return json({ url: 'http://127.0.0.1:7777' });
      if (p === '/api/v1/agents') return json({ agents: [] });
      if (p === '/api/v1/queues' && method === 'POST') {
        const body = JSON.parse(String(init!.body)) as { name: string; rubric: ObserveQueue['rubric'] };
        if (queues.some((q) => q.name === body.name)) return json({ error: 'taken', code: 'LOUSHO_REQUEST_INVALID' }, 409);
        const created = { ...REVIEW, queue_id: 'q2', ...body, counts: { pending: 0, done: 0, skipped: 0 } };
        queues = [created, ...queues];
        return json({ queue: created }, 201);
      }
      if (p === '/api/v1/queues') return json({ queues, total: queues.length, limit: Number(url.searchParams.get('limit')), offset: 0 });
      if (p === '/api/v1/queues/q1') return json({ queue: { ...REVIEW, counts: { ...REVIEW.counts, pending: pending.length } } });
      if (p === '/api/v1/queues/q1/next') return pending.length ? json({ item: pending[0] }) : new Response(null, { status: 204 });
      const complete = /^\/api\/v1\/queues\/q1\/items\/([^/]+)\/complete$/.exec(p);
      if (complete && method === 'POST') {
        pending = pending.filter((i) => i.item_id !== complete[1]);
        if (completeStatus !== 200) return json({ error: 'Item is already done.', code: 'LOUSHO_REQUEST_INVALID' }, completeStatus);
        return json({ item: { ...item(1), status: 'done' }, score_ids: [] });
      }
      const trace = /^\/api\/v1\/traces\/([^/]+)$/.exec(p);
      if (trace) return json({ trace_id: trace[1], observations: [observation(trace[1])], scores: [] });
      if (p.startsWith('/api/v1/queues/')) return json({ error: 'No annotation queue.', code: 'LOUSHO_REQUEST_INVALID' }, 404);
      return json({ error: 'unexpected' }, 500);
    }),
  );
}

async function flush() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mountAt(hash: string) {
  window.history.replaceState(null, '', `/${hash}`);
  const container = render(
    <ToastProvider>
      <QueuesScreen />
    </ToastProvider>,
  );
  await flush();
  return container;
}

const buttonNamed = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name);

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function press(key: string, target: EventTarget = document.body) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
  await flush();
}

const completes = () => calls.filter((c) => c.method === 'POST' && c.path.endsWith('/complete'));
const scoreInput = (container: HTMLElement, name: string) => container.querySelector(`input[name="score-${name}"]`) as HTMLInputElement;
const reviewedTrace = (container: HTMLElement) => container.querySelector('[data-review-trace]')?.getAttribute('data-review-trace');

beforeEach(stubDaemon);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('queue paths', () => {
  it('encodes the id and leaves the default offset out', () => {
    expect(queuesPath()).toBe('/evals/queues');
    expect(queuesPath(50)).toBe('/evals/queues?offset=50');
    expect(queuePath('a b')).toBe('/evals/queues/a%20b');
  });
});

describe('QueuesScreen list', () => {
  it('renders one row per queue with its counts, under the Evaluations tabs', async () => {
    const container = await mountAt('#/evals/queues');
    const row = container.querySelector('tbody tr')!;
    expect(row.textContent).toContain('support-review');
    expect([...row.querySelectorAll('td')].slice(1, 4).map((td) => td.textContent)).toEqual(['2', '3', '1']);
    expect(container.querySelector('nav[aria-label="Evaluations"] [aria-current="page"]')?.textContent).toBe('Annotation queues');
    const list = calls.find((c) => c.path === '/api/v1/queues')!;
    expect(list.query.get('limit')).toBe('50');
  });

  it('shows the empty state when there are no queues', async () => {
    queues = [];
    const container = await mountAt('#/evals/queues');
    expect(container.textContent).toContain('No annotation queues yet');
  });

  it('opens the review view on row open', async () => {
    const container = await mountAt('#/evals/queues');
    act(() => (container.querySelector('tbody tr') as HTMLElement).click());
    expect(window.location.hash).toBe('#/evals/queues/q1');
  });

  it('creates a queue with its rubric rows (blank fields left out) and shows a 409 inline', async () => {
    const container = await mountAt('#/evals/queues');
    const form = container.querySelector('form[aria-label="New annotation queue"]') as HTMLFormElement;
    type(form.querySelector('input[name="queue-name"]') as HTMLInputElement, 'support-review');
    type(form.querySelector('input[name="rubric-name-0"]') as HTMLInputElement, 'accuracy');
    expect(buttonNamed(container, 'Remove rubric row 1')!.disabled).toBe(true);
    await act(async () => buttonNamed(container, 'Add rubric row')!.click());
    type(form.querySelector('input[name="rubric-name-1"]') as HTMLInputElement, 'tone');
    type(form.querySelector('input[name="rubric-description-1"]') as HTMLInputElement, 'Polite?');
    type(form.querySelector('input[name="rubric-min-1"]') as HTMLInputElement, '1');
    type(form.querySelector('input[name="rubric-max-1"]') as HTMLInputElement, '3');

    await act(async () => buttonNamed(container, 'Create queue')!.click());
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('a queue with that name exists');

    type(form.querySelector('input[name="queue-name"]') as HTMLInputElement, 'fresh');
    await act(async () => buttonNamed(container, 'Create queue')!.click());
    await flush();
    expect(calls.filter((c) => c.method === 'POST').at(-1)!.body).toEqual({
      name: 'fresh',
      rubric: [{ name: 'accuracy' }, { name: 'tone', description: 'Polite?', min: 1, max: 3 }],
    });
    expect(container.querySelector('tbody')!.textContent).toContain('fresh');
  });

  it('keeps Create disabled while a rubric row has no name', async () => {
    const container = await mountAt('#/evals/queues');
    type(container.querySelector('input[name="queue-name"]') as HTMLInputElement, 'fresh');
    expect(buttonNamed(container, 'Create queue')!.disabled).toBe(true);
  });
});

describe('QueuesScreen review', () => {
  it('shows the next item trace with one score input per rubric entry, bounds honoured, and the progress counts', async () => {
    const container = await mountAt('#/evals/queues/q1');
    expect(reviewedTrace(container)).toBe('trace-1');
    expect(container.textContent).toContain('run of trace-1');
    const helpfulness = scoreInput(container, 'helpfulness');
    expect([helpfulness.type, helpfulness.min, helpfulness.max]).toEqual(['number', '0', '5']);
    expect(scoreInput(container, 'tone').min).toBe('1');
    expect(container.textContent).toContain('Did it answer the question?');
    expect(container.querySelector('[aria-label="Queue progress"]')?.textContent).toMatch(/2 pending.*3 done.*1 skipped/);
  });

  it('Submit posts only the scored entries (with comments) and loads the next item', async () => {
    const container = await mountAt('#/evals/queues/q1');
    type(scoreInput(container, 'helpfulness'), '4');
    type(container.querySelector('input[name="comment-helpfulness"]') as HTMLInputElement, 'solid');
    await act(async () => buttonNamed(container, 'Submit')!.click());
    await flush();
    expect(completes()).toHaveLength(1);
    expect(completes()[0].path).toBe('/api/v1/queues/q1/items/i1/complete');
    expect(completes()[0].body).toEqual({ scores: [{ name: 'helpfulness', value: 4, comment: 'solid' }] });
    expect(reviewedTrace(container)).toBe('trace-2');
    expect(scoreInput(container, 'helpfulness').value).toBe('');
    expect(container.querySelector('[aria-label="Queue progress"]')?.textContent).toContain('1 pending');
  });

  it('Skip posts status skipped with no scores and loads the next item', async () => {
    const container = await mountAt('#/evals/queues/q1');
    type(scoreInput(container, 'helpfulness'), '4');
    await act(async () => buttonNamed(container, 'Skip')!.click());
    await flush();
    expect(completes()[0].body).toEqual({ scores: [], status: 'skipped' });
    expect(reviewedTrace(container)).toBe('trace-2');
  });

  it('Enter outside a text field submits; S skips; S while typing in a score input does nothing', async () => {
    const container = await mountAt('#/evals/queues/q1');
    await press('s', scoreInput(container, 'helpfulness'));
    expect(completes()).toHaveLength(0);
    await press('S');
    expect(completes()[0].body).toEqual({ scores: [], status: 'skipped' });
    expect(reviewedTrace(container)).toBe('trace-2');
    type(scoreInput(container, 'tone'), '2');
    await press('Enter');
    expect(completes()[1].path).toBe('/api/v1/queues/q1/items/i2/complete');
    expect(completes()[1].body).toEqual({ scores: [{ name: 'tone', value: 2 }] });
  });

  it('Enter on a button leaves the button alone (no submit)', async () => {
    const container = await mountAt('#/evals/queues/q1');
    await press('Enter', buttonNamed(container, 'Tree')!);
    expect(completes()).toHaveLength(0);
  });

  it('shows the empty queue state on 204, with links to the list and to Traces', async () => {
    pending = [];
    const container = await mountAt('#/evals/queues/q1');
    expect(container.textContent).toContain('Queue is empty');
    expect(container.querySelector('.empty-state a[href="#/evals/queues"]')).not.toBeNull();
    expect(container.querySelector('.empty-state a[href="#/traces"]')).not.toBeNull();
    await press('s');
    expect(completes()).toHaveLength(0);
  });

  it('on a 409 (finished elsewhere) toasts and loads the next item', async () => {
    completeStatus = 409;
    const container = await mountAt('#/evals/queues/q1');
    await act(async () => buttonNamed(container, 'Submit')!.click());
    await flush();
    expect(document.body.textContent).toContain('already finished');
    expect(reviewedTrace(container)).toBe('trace-2');
  });

  it('shows the daemon-down state with the URL kept and recovers in place', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      down = true;
      const container = await mountAt('#/evals/queues/q1');
      expect(container.textContent).toContain('lousho observe start');
      expect(container.querySelector('nav[aria-label="Evaluations"]')).not.toBeNull();
      expect(window.location.hash).toBe('#/evals/queues/q1');
      down = false;
      await act(async () => {
        vi.advanceTimersByTime(5100);
      });
      await flush();
      expect(reviewedTrace(container)).toBe('trace-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows not found for an unknown queue, with the way back', async () => {
    const container = await mountAt('#/evals/queues/nope');
    expect(container.textContent).toContain('Queue not found');
    expect(container.querySelector('a[href="#/evals/queues"]')).not.toBeNull();
  });
});
