import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ScreenHeader renders inline here (no shell host); its live run status reads the app state.
vi.mock('../../../state/AppState', () => ({ useAppState: () => ({ runStatus: null }) }));

import { DatasetsScreen } from '../DatasetsScreen';
import { datasetPath } from '../datasetsUrl';
import { render } from '../../../ui/__tests__/render';
import { ToastProvider } from '../../../ui/Toast';
import type { ObserveDataset, ObserveExample } from '../../../observe/types';

const T0 = new Date(2026, 9, 20, 9, 0, 0).getTime();

const GOLDEN: ObserveDataset = {
  dataset_id: 'd1',
  name: 'golden',
  description: 'Hand-picked support cases',
  created_at: T0,
  example_count: 120,
};

const example = (i: number): ObserveExample => ({
  example_id: `e${i}`,
  dataset_id: 'd1',
  input: { question: `q${i}` },
  expected: i % 2 === 0 ? { answer: `a${i}` } : null,
  source_trace_id: i === 1 ? 'trace-1' : null,
  created_at: T0 + i,
});

type Call = { url: URL; method: string; body: unknown };

let datasets: ObserveDataset[];
let calls: Call[];
let down: boolean;

/** Daemon stub behind `/observe`: `golden` holds 120 examples; POST /datasets 409s on a taken name. */
function stubDaemon() {
  datasets = [GOLDEN];
  calls = [];
  down = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (down) throw new TypeError('fetch failed');
      const url = new URL(String(input), 'http://x');
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      const p = url.pathname.replace(/^\/observe/, '');
      if (p === '/health') return json({ service: 'lousho-observe', ok: true });
      if (p === '/__target') return json({ url: 'http://127.0.0.1:7777' });
      if (p === '/api/v1/datasets' && method === 'POST') {
        const { name } = JSON.parse(String(init!.body)) as { name: string };
        if (datasets.some((d) => d.name === name)) {
          return json({ error: `A dataset named '${name}' already exists.`, code: 'LOUSHO_REQUEST_INVALID' }, 409);
        }
        const created = { ...GOLDEN, dataset_id: 'd2', name, description: null, example_count: 0 };
        datasets = [created, ...datasets];
        return json({ dataset: created }, 201);
      }
      if (p === '/api/v1/datasets') {
        return json({ datasets, total: datasets.length, limit: Number(url.searchParams.get('limit')), offset: 0 });
      }
      if (/^\/api\/v1\/datasets\/golden\/examples\/[^/]+$/.test(p) && method === 'DELETE') return new Response(null, { status: 204 });
      if (p === '/api/v1/datasets/golden') {
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? 1000);
        const examples = Array.from({ length: Math.max(0, Math.min(limit, 120 - offset)) }, (_, i) => example(offset + i + 1));
        return json({ dataset: GOLDEN, examples, total: 120, limit, offset });
      }
      if (p.startsWith('/api/v1/datasets/')) return json({ error: 'No dataset.', code: 'LOUSHO_REQUEST_INVALID' }, 404);
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

async function mountAt(hash: string) {
  window.history.replaceState(null, '', `/${hash}`);
  const container = render(
    <ToastProvider>
      <DatasetsScreen />
    </ToastProvider>,
  );
  await flush();
  return container;
}

async function goto(hash: string) {
  await act(async () => {
    window.history.replaceState(null, '', `/${hash}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await flush();
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

beforeEach(stubDaemon);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('datasetPath', () => {
  it('encodes the name and leaves the default offset out', () => {
    expect(datasetPath('golden.v1')).toBe('/evals/datasets/golden.v1');
    expect(datasetPath('a b', 0)).toBe('/evals/datasets/a%20b');
    expect(datasetPath('golden', 50)).toBe('/evals/datasets/golden?offset=50');
  });
});

describe('DatasetsScreen list', () => {
  it('renders one card per dataset with its description, example count and the Evaluations tabs', async () => {
    const container = await mountAt('#/evals/datasets');
    const row = container.querySelector('.ds-grid .ds-card')!;
    expect(row.textContent).toContain('golden');
    expect(row.textContent).toContain('Hand-picked support cases');
    expect(row.textContent).toContain('120');
    const current = container.querySelector('nav[aria-label="Evaluations"] [aria-current="page"]');
    expect(current?.textContent).toBe('Datasets');
    const list = calls.find((c) => c.url.pathname === '/observe/api/v1/datasets')!;
    expect(list.url.searchParams.get('limit')).toBe('50');
    expect(list.url.searchParams.get('offset')).toBe('0');
  });

  it('shows the empty state when there are no datasets', async () => {
    datasets = [];
    const container = await mountAt('#/evals/datasets');
    expect(container.textContent).toContain('No datasets yet');
  });

  it('names a card link by the dataset name and describes it with the rest', async () => {
    const container = await mountAt('#/evals/datasets');
    const link = container.querySelector('.ds-card a')!;
    const text = (ids: string | null) => (ids ?? '').split(' ').map((id) => document.getElementById(id)?.textContent).join(' ');
    expect(text(link.getAttribute('aria-labelledby'))).toBe('golden');
    const described = text(link.getAttribute('aria-describedby'));
    expect(described).toContain('Hand-picked support cases');
    expect(described).toContain('120 examples');
  });

  it('keeps one New dataset button while the form is open over the empty state', async () => {
    datasets = [];
    const container = await mountAt('#/evals/datasets');
    const buttons = () => [...container.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'New dataset');
    expect(buttons()).toHaveLength(2);
    act(() => buttons()[0]!.click());
    expect(buttons()).toHaveLength(1);
    expect(buttons()[0]!.getAttribute('aria-expanded')).toBe('true');
  });

  it('steps back from a stale offset past the end, page by page, to the last real page', async () => {
    // No datasets at all: ?offset=100 is past the end, then so is 50; the first page shows the empty state.
    datasets = [];
    const container = await mountAt('#/evals/datasets?offset=100');
    await flush();
    expect(window.location.hash).toBe('#/evals/datasets');
    expect(container.textContent).toContain('No datasets yet');
  });

  it('opens a dataset from its card link', async () => {
    const container = await mountAt('#/evals/datasets');
    const link = container.querySelector('.ds-card a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('#/evals/datasets/golden');
    act(() => link.click());
    // jsdom follows the fragment link on a later task.
    await flush();
    expect(window.location.hash).toBe('#/evals/datasets/golden');
  });

  it('creates a dataset and shows a 409 inline as a taken name', async () => {
    const container = await mountAt('#/evals/datasets');
    // The form opens from the header's primary "New dataset" button.
    expect(container.querySelector('input[name="dataset-name"]')).toBeNull();
    act(() => buttonNamed(container, 'New dataset')!.click());
    const name = container.querySelector('input[name="dataset-name"]') as HTMLInputElement;
    type(name, 'golden');
    await act(async () => buttonNamed(container, 'Create dataset')!.click());
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('a dataset with that name exists');

    type(name, 'fresh');
    await act(async () => buttonNamed(container, 'Create dataset')!.click());
    await flush();
    const post = calls.filter((c) => c.method === 'POST').at(-1)!;
    expect(post.body).toEqual({ name: 'fresh' });
    expect(container.querySelector('.ds-grid')!.textContent).toContain('fresh');
  });

  it('shows the daemon-down state with the URL kept and recovers in place', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      down = true;
      const container = await mountAt('#/evals/datasets/golden?offset=50');
      expect(container.textContent).toContain('lousho observe start');
      expect(window.location.hash).toBe('#/evals/datasets/golden?offset=50');
      down = false;
      await act(async () => {
        vi.advanceTimersByTime(5100);
      });
      await flush();
      expect(container.textContent).toContain('Dataset');
      expect(container.querySelector('tbody tr')?.textContent).toContain('q51');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('DatasetsScreen detail', () => {
  it('pages the examples server-side and writes the offset to the URL (default unwritten)', async () => {
    const container = await mountAt('#/evals/datasets/golden');
    const first = calls.find((c) => c.url.pathname === '/observe/api/v1/datasets/golden')!;
    expect(first.url.searchParams.get('limit')).toBe('50');
    expect(first.url.searchParams.get('offset')).toBe('0');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(50);
    expect(container.querySelector('a[href="#/traces/trace-1"]')).not.toBeNull();

    await act(async () => buttonNamed(container, 'Next')!.click());
    expect(window.location.hash).toBe('#/evals/datasets/golden?offset=50');
    await flush();
    expect(calls.at(-1)!.url.searchParams.get('offset')).toBe('50');
    expect(container.querySelector('tbody tr')!.textContent).toContain('q51');

    await act(async () => buttonNamed(container, 'Previous')!.click());
    expect(window.location.hash).toBe('#/evals/datasets/golden');
  });

  it('expands a row to show the input and expected values', async () => {
    const container = await mountAt('#/evals/datasets/golden');
    act(() => (container.querySelectorAll('tbody tr')[1] as HTMLElement).click());
    const panel = container.querySelector('[aria-label="Example e2"]')!;
    expect(panel.textContent).toContain('q2');
    expect(panel.textContent).toContain('a2');
  });

  it('deletes an example after confirm, then refreshes', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const container = await mountAt('#/evals/datasets/golden');
    const before = calls.filter((c) => c.url.pathname === '/observe/api/v1/datasets/golden').length;
    await act(async () => buttonNamed(container, 'Delete example e1')!.click());
    await flush();
    expect(confirm).toHaveBeenCalledOnce();
    const del = calls.find((c) => c.method === 'DELETE')!;
    expect(del.url.pathname).toBe('/observe/api/v1/datasets/golden/examples/e1');
    expect(del.body).toBeUndefined();
    expect(calls.filter((c) => c.url.pathname === '/observe/api/v1/datasets/golden').length).toBe(before + 1);
  });

  it('does not delete when the confirm is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const container = await mountAt('#/evals/datasets/golden');
    await act(async () => buttonNamed(container, 'Delete example e1')!.click());
    await flush();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('shows not found for an unknown dataset, with the way back', async () => {
    const container = await mountAt('#/evals/datasets/nope');
    expect(container.textContent).toContain('Dataset not found');
    expect(container.querySelector('a[href="#/evals/datasets"]')).not.toBeNull();
  });

  it('follows a route change to another page', async () => {
    const container = await mountAt('#/evals/datasets/golden');
    await goto('#/evals/datasets/golden?offset=100');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(20);
  });
});
