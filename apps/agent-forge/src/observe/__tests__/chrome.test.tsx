import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ObserveDaemonDown } from '../chrome';
import { render } from '../../ui/__tests__/render';

async function flush() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ObserveDaemonDown', () => {
  it('shows the `lousho observe start` hint as a status region', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      })
    );
    const container = render(<ObserveDaemonDown />);
    await flush();
    expect(container.textContent).toContain('lousho observe start');
    expect(container.textContent).toContain('LOUSHO_OBSERVE=1');
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });

  it('names the proxy target when the daemon is on another port', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/__target')) {
          return new Response(JSON.stringify({ url: 'http://127.0.0.1:7795' }), { status: 200 });
        }
        throw new TypeError('fetch failed');
      })
    );
    const container = render(<ObserveDaemonDown />);
    await flush();
    expect(container.textContent).toContain('LOUSHO_OBSERVE=http://127.0.0.1:7795');
  });
});
