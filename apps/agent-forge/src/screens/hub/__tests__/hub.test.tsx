import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ScreenHeader renders inline here (no shell host); its default status reads the app state.
vi.mock('../../../state/AppState', () => ({ useAppState: () => ({ runStatus: null }) }));

import { HubScreen } from '../HubScreen';
import { fmtSpan, groupNamespaces, parseEditedValue } from '../hubModel';
import { render } from '../../../ui/__tests__/render';
import { ToastProvider } from '../../../ui/Toast';
import type { ObserveAgentRow, ObserveHubEntry } from '../../../observe/types';

const NOW = Date.now();

const agent = (agent_id: string, name: string | null): ObserveAgentRow => ({
  agent_id,
  project: null,
  name,
  version: null,
  first_seen: NOW - 86_400_000,
  last_heartbeat: NOW,
  status: 'healthy',
  heartbeat_age_ms: 0,
  heartbeat_interval_ms: 10_000,
  hostname: null,
  pid: null,
  dropped: null,
  runs_today: 0,
  error_rate_today: 0,
});

const entry = (e: Partial<ObserveHubEntry> & Pick<ObserveHubEntry, 'namespace' | 'key' | 'scope' | 'agent_id'>): ObserveHubEntry => {
  const created_at = e.created_at ?? NOW - 60_000;
  const ttl = e.ttl ?? null;
  return {
    entry_id: `${e.namespace}/${e.agent_id}/${e.key}`,
    value: '"x"',
    created_at,
    ttl,
    expires_at: ttl === null ? null : created_at + ttl,
    ...e,
  };
};

// The writer of the fleet entry is "zeta" (a-2); the viewer defaults to "alpha" (a-1, first by name).
const README = entry({ namespace: 'docs', key: 'readme', scope: 'fleet', agent_id: 'a-2', value: '{"title":"Hi","tags":["a","b"]}', ttl: 3_600_000 });
const DRAFT = entry({ namespace: 'docs', key: 'draft', scope: 'private', agent_id: 'a-1', value: 'plain words here', created_at: NOW - 30_000 });
const CACHE = entry({ namespace: 'cache', key: 'warm', scope: 'fleet', agent_id: 'a-1', value: 'true', created_at: NOW - 120_000 });

let entries: ObserveHubEntry[];
let agents: ObserveAgentRow[];
let hubRequests: URL[];
let posts: unknown[];

function stubDaemon() {
  entries = [DRAFT, README, CACHE];
  agents = [agent('a-2', 'zeta'), agent('a-1', 'alpha')];
  hubRequests = [];
  posts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://x');
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (url.pathname.endsWith('/health')) return json({ service: 'lousho-observe', ok: true });
      if (url.pathname.endsWith('/api/v1/agents')) return json({ agents });
      if (url.pathname.endsWith('/api/v1/hub') && init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)));
        return json({ entry: undefined, created: false });
      }
      if (url.pathname.endsWith('/api/v1/hub')) {
        hubRequests.push(url);
        const q = url.searchParams;
        const viewer = q.get('agent_id');
        const scope = q.get('scope');
        const ns = q.get('namespace');
        const rows = entries.filter(
          (e) =>
            (ns === null || e.namespace === ns) &&
            (scope === 'fleet' ? e.scope === 'fleet' : scope === 'private' ? e.scope === 'private' && e.agent_id === viewer : e.scope === 'fleet' || e.agent_id === viewer)
        );
        return json({ entries: rows });
      }
      return json({ error: 'unexpected' }, 500);
    })
  );
}

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mountAt(hash: string) {
  window.history.replaceState(null, '', `/${hash}`);
  const container = render(
    <ToastProvider>
      <HubScreen />
    </ToastProvider>
  );
  await flush();
  return container;
}

/** Namespace rows (a table) or entry cards (buttons). */
const rows = (c: HTMLElement) => [...c.querySelectorAll('tbody tr, .hub-card')] as HTMLElement[];
const rowFor = (c: HTMLElement, text: string) => rows(c).find((r) => r.textContent?.includes(text))!;
const buttonNamed = (c: HTMLElement, name: string) => [...c.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
const lastHub = () => hubRequests[hubRequests.length - 1].searchParams;

async function open(row: HTMLElement) {
  act(() => row.click());
  await flush();
}

function typeInto(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(stubDaemon);
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('hubModel', () => {
  it('groups entries by namespace with fleet/private counts and the newest update', () => {
    expect(groupNamespaces([DRAFT, README, CACHE])).toEqual([
      { namespace: 'cache', entries: 1, fleet: 1, private: 0, updated: CACHE.created_at },
      { namespace: 'docs', entries: 2, fleet: 1, private: 1, updated: DRAFT.created_at },
    ]);
  });

  it('parses an edit: JSON when it parses, the string for a plain-string entry, invalid for a JSON entry', () => {
    expect(parseEditedValue('{"a":1}', true)).toEqual({ ok: true, value: { a: 1 } });
    expect(parseEditedValue('just text', false)).toEqual({ ok: true, value: 'just text' });
    expect(parseEditedValue('{"a":', true)).toEqual({ ok: false });
  });

  it('formats a span in its two largest units', () => {
    expect(fmtSpan(3_600_000)).toBe('1h');
    expect(fmtSpan(5_400_000)).toBe('1h 30m');
    expect(fmtSpan(45_000)).toBe('45s');
    expect(fmtSpan(2 * 86_400_000 + 3_600_000)).toBe('2d 1h');
  });
});

describe('HubScreen', () => {
  it("#/hub lists namespaces derived from the viewer agent's entries (first agent by name)", async () => {
    const c = await mountAt('#/hub');
    expect(lastHub().get('agent_id')).toBe('a-1');
    expect(lastHub().get('limit')).toBe('1000');
    expect(lastHub().get('namespace')).toBeNull();
    const viewer = c.querySelector('select[aria-label="Viewing as"]') as HTMLSelectElement;
    expect(viewer.value).toBe('a-1');
    expect([...viewer.options].map((o) => o.textContent)).toEqual(['alpha', 'zeta']);
    expect(rows(c).map((r) => r.querySelector('td')?.textContent)).toEqual(['cache', 'docs']);
    const docs = [...rowFor(c, 'docs').querySelectorAll('td')].map((td) => td.textContent);
    expect(docs.slice(0, 4)).toEqual(['docs', '2', '1', '1']);
    expect(c.textContent).toContain("Private entries shown are alpha's");
    expect(c.textContent).not.toContain('may be incomplete');
  });

  it('opening a namespace goes to #/hub/:namespace and keeps the query', async () => {
    const c = await mountAt('#/hub?scope=fleet');
    await open(rowFor(c, 'docs'));
    expect(window.location.hash).toBe('#/hub/docs?scope=fleet');
  });

  it('notes when the daemon returned the 1000-row cap', async () => {
    entries = Array.from({ length: 1000 }, (_, i) => entry({ namespace: `ns${i % 3}`, key: `k${i}`, scope: 'fleet', agent_id: 'a-1' }));
    const c = await mountAt('#/hub');
    expect(c.textContent).toContain('may be incomplete');
  });

  it('the scope filter: ?scope=fleet is sent to the daemon, and picking a scope writes the URL', async () => {
    let c = await mountAt('#/hub/docs?scope=fleet');
    expect(lastHub().get('scope')).toBe('fleet');
    expect(lastHub().get('namespace')).toBe('docs');
    expect(rows(c).map((r) => r.textContent)).toHaveLength(1);

    c = await mountAt('#/hub/docs');
    expect(lastHub().get('scope')).toBeNull();
    const scope = c.querySelector('select[aria-label="Scope"]') as HTMLSelectElement;
    expect(scope.value).toBe('');
    act(() => {
      scope.value = 'private';
      scope.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(window.location.hash).toBe('#/hub/docs?scope=private');
    expect(lastHub().get('scope')).toBe('private');

    const s2 = c.querySelector('select[aria-label="Scope"]') as HTMLSelectElement;
    act(() => {
      s2.value = '';
      s2.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(window.location.hash).toBe('#/hub/docs');
  });

  it('switching the viewer writes ?agent= (the default writes nothing)', async () => {
    const c = await mountAt('#/hub/docs');
    const viewer = c.querySelector('select[aria-label="Viewing as"]') as HTMLSelectElement;
    act(() => {
      viewer.value = 'a-2';
      viewer.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(window.location.hash).toBe('#/hub/docs?agent=a-2');
    expect(lastHub().get('agent_id')).toBe('a-2');
  });

  it('the key/value table shows key, preview, scope, writer name, updated and TTL', async () => {
    const c = await mountAt('#/hub/docs');
    const readme = rowFor(c, 'readme');
    expect(readme.textContent).toContain('{"title":"Hi"');
    expect(readme.querySelector('.status-pill')?.textContent).toBe('fleet');
    expect(readme.textContent).toContain('zeta');
    expect(readme.textContent).toMatch(/1h - expires in 5[89]m/);
    const draft = rowFor(c, 'draft');
    expect(draft.querySelector('.status-pill')?.textContent).toBe('private');
    expect(draft.textContent).toContain('alpha');
    expect(draft.textContent).toContain('never');
    // Updated carries seconds.
    expect(draft.textContent).toMatch(/\d\d:\d\d:\d\d/);
  });

  it('a JSON value renders with JsonView; a plain string renders as preformatted text', async () => {
    const c = await mountAt('#/hub/docs');
    await open(rowFor(c, 'readme'));
    const detail = c.querySelector('.hub-value')!;
    expect(detail.querySelector('.json-node')).not.toBeNull();
    expect(detail.textContent).toContain('title');
    expect(detail.querySelector('pre')).toBeNull();

    await open(rowFor(c, 'draft'));
    const plain = c.querySelector('.hub-value')!;
    expect(plain.querySelector('.json-node')).toBeNull();
    expect(plain.querySelector('pre')?.textContent).toBe('plain words here');
  });

  it('entry cards answer j/k, and the open card is aria-current', async () => {
    const c = await mountAt('#/hub/docs');
    const cards = [...c.querySelectorAll<HTMLButtonElement>('.hub-card')];
    expect(cards).toHaveLength(2);
    cards[0].focus();
    act(() => cards[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true })));
    expect(document.activeElement).toBe(cards[1]);
    await open(cards[1]);
    expect(c.querySelector('.hub-card[aria-current="true"]')).toBe(cards[1]);
    expect(c.querySelector('section.hub-entry')?.getAttribute('aria-label')).toBe(`Entry ${cards[1].querySelector('.hub-card-key')?.textContent}`);
  });

  it('private entries have no Edit; fleet entries do', async () => {
    const c = await mountAt('#/hub/docs');
    await open(rowFor(c, 'draft'));
    expect(buttonNamed(c, 'Edit')).toBeUndefined();
    await open(rowFor(c, 'readme'));
    expect(buttonNamed(c, 'Edit')).toBeDefined();
  });

  it("Edit on a fleet entry POSTs the writer's agent_id, scope fleet and the original ttl, then refreshes", async () => {
    const c = await mountAt('#/hub/docs');
    await open(rowFor(c, 'readme'));
    act(() => buttonNamed(c, 'Edit')!.click());
    const textarea = c.querySelector('textarea') as HTMLTextAreaElement;
    expect(JSON.parse(textarea.value)).toEqual({ title: 'Hi', tags: ['a', 'b'] });
    expect(c.textContent).toContain('restarts the TTL clock');

    // Invalid JSON stays in the editor and sends nothing.
    typeInto(textarea, '{"title":');
    act(() => buttonNamed(c, 'Save')!.click());
    await flush();
    expect(posts).toHaveLength(0);
    expect(c.querySelector('textarea')).not.toBeNull();

    typeInto(c.querySelector('textarea') as HTMLTextAreaElement, '{"title":"Bye"}');
    const before = hubRequests.length;
    act(() => buttonNamed(c, 'Save')!.click());
    await flush();
    expect(posts).toEqual([{ agent_id: 'a-2', namespace: 'docs', key: 'readme', value: { title: 'Bye' }, scope: 'fleet', ttl: 3_600_000 }]);
    expect(c.querySelector('textarea')).toBeNull();
    expect(hubRequests.length).toBeGreaterThan(before);
    expect(document.body.textContent).toContain('Saved readme');
  });

  it('Cancel closes the editor without a request', async () => {
    const c = await mountAt('#/hub/docs');
    await open(rowFor(c, 'readme'));
    act(() => buttonNamed(c, 'Edit')!.click());
    act(() => buttonNamed(c, 'Cancel')!.click());
    expect(c.querySelector('textarea')).toBeNull();
    expect(posts).toHaveLength(0);
  });

  it('no agents: an empty state explaining that agents publish to the hub, and no hub request', async () => {
    agents = [];
    const c = await mountAt('#/hub');
    expect(c.textContent).toContain('No agents yet');
    expect(hubRequests).toHaveLength(0);
  });
});
