import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AddToDataset } from '../AddToDataset';
import { render } from '../../../ui/__tests__/render';
import { ToastProvider } from '../../../ui/Toast';

type Call = { path: string; method: string; body: unknown };

let calls: Call[];
let failAdd: boolean;

/** Daemon stub behind `/observe`: one dataset `golden`; adding an example answers 201 (or 400 with `failAdd`). */
function stubDaemon() {
  calls = [];
  failAdd = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://x');
      const method = init?.method ?? 'GET';
      const path = url.pathname.replace(/^\/observe/, '');
      calls.push({ path, method, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (path === '/api/v1/datasets' && method === 'GET') {
        const golden = { dataset_id: 'd1', name: 'golden', description: null, created_at: 1, example_count: 3 };
        return json({ datasets: [golden], total: 1, limit: 1000, offset: 0 });
      }
      if (path === '/api/v1/datasets' && method === 'POST') return json({ dataset: { name: 'fresh' } }, 201);
      if (/^\/api\/v1\/datasets\/[^/]+\/examples$/.test(path)) {
        if (failAdd) return json({ error: "Trace 't1' has no captured input (content capture was off).", code: 'LOUSHO_REQUEST_INVALID' }, 400);
        return json({ example: { example_id: 'e9' } }, 201);
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
      <AddToDataset traceId="t1" />
    </ToastProvider>,
  );
  const trigger = container.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement;
  await act(async () => trigger.click());
  await flush();
  return { container, trigger };
}

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

const dialog = (container: HTMLElement) => container.querySelector('[role="dialog"]') as HTMLElement | null;
const submit = (container: HTMLElement) =>
  [...dialog(container)!.querySelectorAll('button')].find((b) => b.textContent === 'Add') as HTMLButtonElement;

beforeEach(stubDaemon);
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('AddToDataset', () => {
  it('opens a labelled dialog listing the datasets', async () => {
    const { container, trigger } = await mount();
    expect(trigger.textContent).toBe('Add to dataset');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(dialog(container)?.getAttribute('aria-label')).toBe('Add to dataset');
    const options = [...dialog(container)!.querySelectorAll('option')].map((o) => o.textContent);
    expect(options).toEqual(['golden', 'New dataset...']);
  });

  it('posts exactly { from_trace_id } to the chosen dataset, toasts a link to it and closes', async () => {
    const { container, trigger } = await mount();
    await act(async () => submit(container).click());
    await flush();
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post).toEqual({ path: '/api/v1/datasets/golden/examples', method: 'POST', body: { from_trace_id: 't1' } });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(container.textContent).toContain('Added trace to golden');
    expect(dialog(container)).toBeNull();
    expect(document.activeElement).toBe(trigger);

    const open = [...container.querySelectorAll('.toast button')].find((b) => b.textContent === 'Open dataset') as HTMLButtonElement;
    act(() => open.click());
    expect(window.location.hash).toBe('#/evals/datasets/golden');
  });

  it('creates a new dataset first when a new name is chosen', async () => {
    const { container } = await mount();
    setValue(dialog(container)!.querySelector('select')!, '');
    setValue(dialog(container)!.querySelector('input[name="new-dataset-name"]') as HTMLInputElement, 'fresh');
    await act(async () => submit(container).click());
    await flush();
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toEqual([
      { path: '/api/v1/datasets', method: 'POST', body: { name: 'fresh' } },
      { path: '/api/v1/datasets/fresh/examples', method: 'POST', body: { from_trace_id: 't1' } },
    ]);
  });

  it('shows a failure in a toast and keeps the dialog open', async () => {
    failAdd = true;
    const { container } = await mount();
    await act(async () => submit(container).click());
    await flush();
    expect(container.querySelector('.toast[role="alert"]')?.textContent).toContain('no captured input');
    expect(dialog(container)).not.toBeNull();
  });

  it('closes on Escape and returns focus to the button', async () => {
    const { container, trigger } = await mount();
    expect(dialog(container)!.contains(document.activeElement)).toBe(true);
    act(() => {
      dialog(container)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(dialog(container)).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
