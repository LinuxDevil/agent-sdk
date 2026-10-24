import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonStatus } from '../DaemonStatus';
import { ObserveView } from '../../observe/ObserveView';

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
  it('reads "checking" until the first health probe settles', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    await render(<DaemonStatus />);
    expect(container.textContent).toBe('Collector: checking…');
  });

  it('reads "not reachable" while the daemon is down', async () => {
    stubProxy();
    await render(<DaemonStatus />);
    await flush();
    expect(container.textContent).toBe('Collector: not reachable');
  });

  it('names the proxy target once the daemon answers, without a reload', async () => {
    const { daemon } = stubProxy();
    await render(<DaemonStatus />);
    await flush();
    expect(container.textContent).toBe('Collector: not reachable');
    daemon.up = true;
    await poll();
    expect(container.textContent).toBe(`Collector: running at ${TARGET}`);
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
    expect(container.textContent).toBe('Collector: not reachable');
    await act(async () => release());
    expect(daemon.up).toBe(false);
  });
});

describe('observe screens with the daemon down', () => {
  it('keeps the deep-linked URL, shows the down state, and re-fetches the list in place on recovery', async () => {
    window.location.hash = '#/traces/abc';
    const { daemon, listCalls } = stubProxy();
    await render(<ObserveView tab="traces" onTabChange={() => {}} />);
    await flush();
    expect(container.textContent).toContain('the observe daemon is not reachable');
    // The panels may try once while the first probe is pending; after that, polls must not wake them.
    const whileDown = listCalls();
    await poll();
    await poll();
    expect(container.textContent).toContain('the observe daemon is not reachable');
    expect(listCalls()).toBe(whileDown);
    expect(window.location.hash).toBe('#/traces/abc');

    daemon.up = true;
    await poll();
    expect(listCalls()).toBeGreaterThan(whileDown);
    expect(container.textContent).toContain('No traces match');
    expect(window.location.hash).toBe('#/traces/abc');
  });
});
