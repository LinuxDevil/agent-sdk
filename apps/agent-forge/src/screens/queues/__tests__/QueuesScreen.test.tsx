import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ScreenHeader renders inline here (no shell host); its live run status reads the app state.
vi.mock('../../../state/AppState', () => ({ useAppState: () => ({ runStatus: null }) }));

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

/** A button's name: its aria-label, else its text without aria-hidden parts (the kbd hints). */
function nameOf(button: HTMLButtonElement): string {
  const label = button.getAttribute('aria-label');
  if (label) return label;
  const copy = button.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('[aria-hidden="true"]').forEach((el) => el.remove());
  return copy.textContent?.trim() ?? '';
}

const buttonNamed = (container: HTMLElement, name: string) => [...container.querySelectorAll('button')].find((b) => nameOf(b) === name);

function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
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
  it('renders one card per queue with its rubric chips and counts, under the Evaluations tabs', async () => {
    const container = await mountAt('#/evals/queues');
    const card = container.querySelector('.ds-grid .qu-card')!;
    expect(card.textContent).toContain('support-review');
    expect([...card.querySelectorAll('.qu-chip')].map((c) => c.textContent)).toEqual(['helpfulness0–5', 'tone1–3']);
    // pending / done / skipped: 2 / 3 / 1.
    expect(card.querySelector('.qu-pending')?.textContent).toBe('2 pending');
    expect(card.querySelector('.qu-reviewed')?.textContent).toBe('3 reviewed of 6');
    expect(card.querySelector('.qu-skipped')?.textContent).toBe('1 skipped');
    expect(container.querySelector('nav[aria-label="Evaluations"] [aria-current="page"]')?.textContent).toBe('Annotation queues');
    const list = calls.find((c) => c.path === '/api/v1/queues')!;
    expect(list.query.get('limit')).toBe('50');
  });

  it('shows the empty state when there are no queues', async () => {
    queues = [];
    const container = await mountAt('#/evals/queues');
    expect(container.textContent).toContain('No annotation queues yet');
    expect(buttonNamed(container.querySelector('.empty-state') as HTMLElement, 'New queue')).toBeDefined();
  });

  it('links each card to its review view', async () => {
    const container = await mountAt('#/evals/queues');
    expect(container.querySelector('.qu-card')?.getAttribute('href')).toBe('#/evals/queues/q1');
  });

  it('creates a queue with its rubric rows (blank fields left out) and shows a 409 inline', async () => {
    const container = await mountAt('#/evals/queues');
    expect(container.querySelector('form[aria-label="New annotation queue"]')).toBeNull();
    await act(async () => buttonNamed(container, 'New queue')!.click());
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
    expect(container.querySelector('.ds-grid')!.textContent).toContain('fresh');
    expect(container.querySelector('form[aria-label="New annotation queue"]')).toBeNull();
  });

  it('keeps Create disabled while a rubric row has no name', async () => {
    const container = await mountAt('#/evals/queues');
    await act(async () => buttonNamed(container, 'New queue')!.click());
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
    // n of m: n = done + skipped + 1, m = done + skipped + pending.
    expect(container.querySelector('.qu-position')?.textContent).toBe('Item 5 of 6');
    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('4');
    // Messages is the default view: the root step's input and output.
    expect(buttonNamed(container, 'Messages')!.getAttribute('aria-pressed')).toBe('true');
    expect([...container.querySelectorAll('.mv-body')].map((b) => b.textContent)).toEqual(['"hello"', '"hi"']);
  });

  it('switches the item to the whole trace and back', async () => {
    const container = await mountAt('#/evals/queues/q1');
    expect(buttonNamed(container, 'Tree')).toBeUndefined();
    await act(async () => buttonNamed(container, 'Trace')!.click());
    expect(buttonNamed(container, 'Trace')!.getAttribute('aria-pressed')).toBe('true');
    expect(buttonNamed(container, 'Tree')).toBeDefined();
    await act(async () => buttonNamed(container, 'Messages')!.click());
    expect(container.querySelectorAll('.mv-body')).toHaveLength(2);
  });

  it('a score button sets the value and picking it again clears it', async () => {
    const container = await mountAt('#/evals/queues/q1');
    const tone = container.querySelector('[role="group"][aria-label="tone score"]') as HTMLElement;
    expect([...tone.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['1', '2', '3']);
    await act(async () => buttonNamed(tone, '2')!.click());
    expect(scoreInput(container, 'tone').value).toBe('2');
    expect(buttonNamed(tone, '2')!.getAttribute('aria-pressed')).toBe('true');
    await act(async () => buttonNamed(tone, '2')!.click());
    expect(scoreInput(container, 'tone').value).toBe('');
  });

  it('Enter in a comment submits; Shift+Enter does not', async () => {
    const container = await mountAt('#/evals/queues/q1');
    const comment = container.querySelector('textarea[name="comment-tone"]') as HTMLTextAreaElement;
    type(scoreInput(container, 'tone'), '3');
    await act(async () => {
      comment.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
    });
    await flush();
    expect(completes()).toHaveLength(0);
    await press('Enter', comment);
    expect(completes()[0].body).toEqual({ scores: [{ name: 'tone', value: 3 }] });
  });

  it('Submit posts only the scored entries (with comments) and loads the next item', async () => {
    const container = await mountAt('#/evals/queues/q1');
    type(scoreInput(container, 'helpfulness'), '4');
    type(container.querySelector('textarea[name="comment-helpfulness"]') as HTMLTextAreaElement, 'solid');
    await act(async () => buttonNamed(container, 'Submit & next')!.click());
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
    await act(async () => buttonNamed(container, 'Trace')!.click());
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
    await act(async () => buttonNamed(container, 'Submit & next')!.click());
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
