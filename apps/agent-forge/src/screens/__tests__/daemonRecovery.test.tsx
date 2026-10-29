import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HubScreen } from '../hub/HubScreen';
import { PromptsScreen } from '../prompts/PromptsScreen';
import { ThreadsScreen } from '../threads/ThreadsScreen';
import { TracesScreen } from '../traces/TracesScreen';
import { render } from '../../ui/__tests__/render';
import { ToastProvider } from '../../ui/Toast';

/** The health probe always answers; every other request fails like a refused connection while `outage` holds. */
let outage: boolean;

function stubDaemon() {
  outage = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://x');
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (url.pathname.endsWith('/health')) return json({ service: 'lousho-observe', ok: true });
      if (outage) throw new TypeError('fetch failed');
      if (url.pathname.endsWith('/api/v1/agents')) return json({ agents: [{ agent_id: 'a1', name: 'alpha', project: null }] });
      if (url.pathname.endsWith('/api/v1/traces')) return json({ traces: [], total: 0, limit: 50, offset: 0 });
      if (url.pathname.endsWith('/api/v1/sessions')) return json({ sessions: [], total: 0, limit: 50, offset: 0 });
      if (url.pathname.includes('/api/v1/sessions/')) return json({ error: 'No session', code: 'LOUSHO_REQUEST_INVALID' }, 404);
      if (url.pathname.endsWith('/api/v1/prompts')) return json({ prompts: [] });
      if (url.pathname.includes('/api/v1/prompts/')) return json({ error: 'No prompt', code: 'LOUSHO_REQUEST_INVALID' }, 404);
      if (url.pathname.endsWith('/api/v1/hub')) return json({ entries: [] });
      return json({ error: 'unexpected' }, 500);
    })
  );
}

async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  stubDaemon();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

const CASES: [string, string, () => JSX.Element, string][] = [
  ['Traces', '#/traces', () => <TracesScreen />, 'No traces match these filters'],
  ['Threads', '#/threads', () => <ThreadsScreen />, 'No threads match these filters'],
  ['Thread', '#/threads/s1', () => <ThreadsScreen />, 'Thread not found'],
  ['Prompts', '#/prompts', () => <PromptsScreen />, 'No prompts yet'],
  ['Prompt', '#/prompts/mira', () => <PromptsScreen />, 'Prompt not found'],
  ['Hub', '#/hub', () => <HubScreen />, 'Context Hub'],
];

describe('observe screens recover in place after a daemon restart', () => {
  it.each(CASES)('%s: a failed query shows daemon-down, then the screen returns without a reload', async (_name, hash, screen, back) => {
    window.history.replaceState(null, '', `/${hash}`);
    const container = render(<ToastProvider>{screen()}</ToastProvider>);
    await flush();
    expect(container.textContent).toContain('lousho observe start');
    expect(window.location.hash).toBe(hash);

    outage = false;
    await act(async () => {
      vi.advanceTimersByTime(5100);
    });
    await flush();
    expect(container.textContent).not.toContain('lousho observe start');
    expect(container.textContent).toContain(back);
    expect(window.location.hash).toBe(hash);
  });
});
