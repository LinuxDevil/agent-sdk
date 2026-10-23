import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ObserveView } from '../ObserveView';

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
});
