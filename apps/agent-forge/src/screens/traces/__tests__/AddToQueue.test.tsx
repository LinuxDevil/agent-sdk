import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AddToQueue } from '../AddToQueue';
import { render } from '../../../ui/__tests__/render';
import { ToastProvider } from '../../../ui/Toast';

type Call = { path: string; method: string; body: unknown };

let calls: Call[];
let queues: { queue_id: string; name: string }[];
let alreadyQueued: boolean;

/** Daemon stub behind `/observe`: the `queues` list; adding items answers `{ added: ItemRow[], skipped_existing: traceId[] }`. */
function stubDaemon() {
  calls = [];
  alreadyQueued = false;
  queues = [
    { queue_id: 'q1', name: 'support-review' },
    { queue_id: 'q2', name: 'billing-review' },
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://x');
      const method = init?.method ?? 'GET';
      const path = url.pathname.replace(/^\/observe/, '');
      calls.push({ path, method, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (path === '/api/v1/queues') {
        const rows = queues.map((q) => ({ ...q, rubric: [], created_at: 1, counts: { pending: 0, done: 0, skipped: 0 } }));
        return json({ queues: rows, total: rows.length, limit: 1000, offset: 0 });
      }
      if (/^\/api\/v1\/queues\/[^/]+\/items$/.test(path)) {
        const queued = { item_id: 'i1', queue_id: 'q1', trace_id: 't1', status: 'pending', reviewer: null, created_at: 1, done_at: null };
        return json(alreadyQueued ? { added: [], skipped_existing: ['t1'] } : { added: [queued], skipped_existing: [] }, 201);
      }
      return json({ error: 'unexpected' }, 500);
    }),
  );
}

async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount() {
  const container = render(
    <ToastProvider>
      <AddToQueue traceId="t1" />
    </ToastProvider>,
  );
  const trigger = container.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement;
  await act(async () => trigger.click());
  await flush();
  return { container, trigger };
}

const buttonNamed = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);

beforeEach(stubDaemon);
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('AddToQueue', () => {
  it('posts the trace to the picked queue and toasts with a link to its review view', async () => {
    const { container } = await mount();
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Add to queue');
    const select = container.querySelector('select') as HTMLSelectElement;
    expect(document.activeElement).toBe(select);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'q2');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => buttonNamed(container, 'Add')!.click());
    await flush();
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.path).toBe('/api/v1/queues/q2/items');
    expect(post.body).toEqual({ trace_ids: ['t1'] });
    expect(document.body.textContent).toContain('Added trace to billing-review.');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => buttonNamed(document.body, 'Review queue')!.click());
    expect(window.location.hash).toBe('#/evals/queues/q2');
  });

  it('says so when the trace is already in the queue', async () => {
    alreadyQueued = true;
    const { container } = await mount();
    await act(async () => buttonNamed(container, 'Add')!.click());
    await flush();
    expect(document.body.textContent).toContain('The trace is already in support-review.');
  });

  it('with no queues, links to the queue list and keeps Add disabled', async () => {
    queues = [];
    const { container } = await mount();
    expect(container.querySelector('[role="dialog"] a[href="#/evals/queues"]')).not.toBeNull();
    expect(buttonNamed(container, 'Add')!.disabled).toBe(true);
  });

  it('closes on Escape and returns focus to the button', async () => {
    const { container, trigger } = await mount();
    await act(async () => {
      container.querySelector('select')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
