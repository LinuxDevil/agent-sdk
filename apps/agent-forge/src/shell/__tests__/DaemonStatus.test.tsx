import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ScreenHeader renders inline here (no shell host); its live run status reads the app state.
vi.mock('../../state/AppState', () => ({ useAppState: () => ({ runStatus: null }) }));

import { DaemonStatus } from '../DaemonStatus';
import { TracesScreen } from '../../screens/traces/TracesScreen';
import { TraceScreen } from '../../screens/traces/TraceScreen';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TARGET = 'http://127.0.0.1:7795';

/** A fake `/observe` proxy whose daemon can be switched on and off; `__target` always answers (the Studio server owns it). */
function stubProxy() {
  const daemon = { up: false };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/__target')) return new Response(JSON.stringify({ url: TARGET }), { status: 200 });
    if (!daemon.up) return new Response('', { status: 502 });
    if (url.endsWith('/health')) return new Response(JSON.stringify({ service: 'lousho-observe', ok: true }), { status: 200 });
    if (url.includes('/api/v1/agents')) return new Response(JSON.stringify({ agents: [] }), { status: 200 });
    if (url.includes('/api/v1/traces/')) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    return new Response(JSON.stringify({ traces: [], total: 0, limit: 50, offset: 0 }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const listCalls = () => fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/v1/traces')).length;
  return { daemon, fetchMock, listCalls };
}

let root: Root | undefined;
let container: HTMLDivElement;

async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function render(node: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
}

async function poll() {
  await act(async () => {
    vi.advanceTimersByTime(5000);
  });
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  root = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('DaemonStatus', () => {
  const card = () => container.querySelector('[role="status"]') as HTMLElement;
  const label = () => card().querySelector('.nav-daemon-label')?.textContent;
  const url = () => card().querySelector('.nav-daemon-url')?.textContent;

  it('reads "checking" until the first health probe settles', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    await render(<DaemonStatus />);
    expect(container.textContent).toBe('Checking collector…');
    expect(card().getAttribute('data-state')).toBe('checking');
    expect(card().getAttribute('title')).toBe('Checking collector…');
  });

  it('reads "unreachable" while the daemon is down', async () => {
    stubProxy();
    await render(<DaemonStatus />);
    await flush();
    expect(container.textContent).toBe('Collector unreachable');
    expect(card().getAttribute('data-state')).toBe('down');
    expect(card().getAttribute('title')).toBe('Collector unreachable');
  });

  it('names the proxy target once the daemon answers, without a reload', async () => {
    const { daemon } = stubProxy();
    await render(<DaemonStatus />);
    await flush();
    expect(label()).toBe('Collector unreachable');
    daemon.up = true;
    await poll();
    expect(label()).toBe('Collector running');
    expect(card().getAttribute('data-state')).toBe('up');
    expect(url()).toBe(TARGET);
    expect(card().getAttribute('title')).toBe(`Collector running at ${TARGET}`);
    expect(card().querySelector('.nav-daemon-url')?.getAttribute('title')).toBe(TARGET);
  });

  it('stays "not reachable" while a re-probe is in flight (no flicker)', async () => {
    const { daemon, fetchMock } = stubProxy();
    await render(<DaemonStatus />);
    await flush();
    let release!: () => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (release = () => resolve(new Response('', { status: 502 }))))
    );
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(label()).toBe('Collector unreachable');
    await act(async () => release());
    expect(daemon.up).toBe(false);
  });
});

describe('observe screens with the daemon down', () => {
  // The list stays quiet while down (it waits for the health probe); the trace screen re-polls its detail by design.
  it.each([
    { hash: '#/traces?status=error', node: () => <TracesScreen />, recovered: 'No traces match', quiet: true },
    { hash: '#/traces/abc', node: () => <TraceScreen traceId="abc" />, recovered: 'Trace not found', quiet: false },
  ])('keeps the deep-linked URL $hash, shows the down state, and re-fetches in place on recovery', async ({ hash, node, recovered, quiet }) => {
    window.location.hash = hash;
    const { daemon, listCalls } = stubProxy();
    await render(node());
    await flush();
    expect(container.textContent).toContain('the observe daemon is not reachable');
    // The screen may try once while the first probe is pending; after that, polls must not wake the list.
    const whileDown = listCalls();
    await poll();
    await poll();
    expect(container.textContent).toContain('the observe daemon is not reachable');
    if (quiet) expect(listCalls()).toBe(whileDown);
    expect(window.location.hash).toBe(hash);

    daemon.up = true;
    const beforeUp = listCalls();
    await poll();
    expect(listCalls()).toBeGreaterThan(beforeUp);
    expect(container.textContent).toContain(recovered);
    expect(window.location.hash).toBe(hash);
  });
});
