import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ObserveView } from '../ObserveView';
import { TraceDetailView } from '../TraceDetailView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('ObserveView', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the `lousho observe start` hint when the daemon is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      })
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<ObserveView />);
    });
    await flush();
    expect(container.textContent).toContain('lousho observe start');
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });

  it('names the proxy target in the down hint when the daemon is on another port', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/__target')) {
          return new Response(JSON.stringify({ url: 'http://127.0.0.1:7795' }), { status: 200 });
        }
        throw new TypeError('fetch failed');
      })
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<ObserveView />);
    });
    await flush();
    await flush();
    expect(container.textContent).toContain('LOUSHO_OBSERVE=http://127.0.0.1:7795');
  });

  it('renders the trace list once the daemon answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/health')) {
          return new Response(JSON.stringify({ service: 'lousho-observe', ok: true }), { status: 200 });
        }
        if (url.includes('/api/v1/agents')) {
          return new Response(JSON.stringify({ agents: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({ traces: [], total: 0, limit: 50, offset: 0 }), { status: 200 });
      })
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<ObserveView />);
    });
    await flush();
    await flush();
    expect(container.textContent).not.toContain('the observe daemon is not reachable');
    expect(container.textContent).toContain('No traces match');
  });

  it('a missing trace keeps a Traces button that goes back, plus the flush hint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: "No trace 'gone'." }), { status: 404 }))
    );
    const onBack = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<TraceDetailView traceId="gone" onBack={onBack} />);
    });
    await flush();
    await flush();
    expect(container.textContent).toContain("No trace 'gone'");
    expect(container.textContent).toContain('reporter never flushed');
    const back = Array.from(container.querySelectorAll('button')).find((b) => /Traces/.test(b.textContent ?? ''));
    expect(back).toBeDefined();
    act(() => back!.click());
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  function stubDaemon() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/health')) {
          return new Response(JSON.stringify({ service: 'lousho-observe', ok: true }), { status: 200 });
        }
        if (url.includes('/api/v1/agents')) {
          return new Response(JSON.stringify({ agents: [] }), { status: 200 });
        }
        if (url.includes('/api/v1/insights')) {
          return new Response(JSON.stringify({ window: { since: 0, until: 1 }, agents: [], series: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({ traces: [], total: 0, limit: 50, offset: 0 }), { status: 200 });
      })
    );
  }

  async function renderView(node: React.ReactElement) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(node);
    });
    await flush();
    await flush();
  }

  it('hides its own tab strip when the route picks the panel', async () => {
    stubDaemon();
    await renderView(<ObserveView tab="traces" onTabChange={() => {}} />);
    expect(container!.querySelector('[role="tablist"]')).toBeNull();
    expect(container!.textContent).toContain('No traces match');
  });
});
