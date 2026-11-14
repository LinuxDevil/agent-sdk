import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ScreenHeader renders inline here (no shell host); its live run status reads the app state.
vi.mock('../../../state/AppState', () => ({ useAppState: () => ({ runStatus: null }) }));

const api = vi.hoisted(() => ({
  listAgents: vi.fn(),
  listAllAgentItems: vi.fn(),
  patchAgentMeta: vi.fn(),
  createAgentRecord: vi.fn(),
  forWorkspace: vi.fn(),
}));
vi.mock('../../../runtime/runtimeClient', () => ({ runtimeClient: api }));

// The workspace list/launch id the screen reads for names, chips and the
// blank-create fallback. `activeId` mirrors the URL's workspace.
const wsState = vi.hoisted(() => ({
  list: undefined as unknown[] | undefined,
  launchId: undefined as string | undefined,
  activeId: undefined as string | undefined,
}));
vi.mock('../../../workspace/WorkspacesProvider', () => ({
  useWorkspacesMaybe: () => ({
    list: wsState.list,
    launchId: wsState.launchId,
    activeId: wsState.activeId,
    error: undefined,
    refresh: vi.fn(),
  }),
}));

import type { AgentListItem, AgentRecord, WorkspaceAgentItem, WorkspaceListItem } from '../../../../shared/wireTypes';
import { AgentListScreen } from '../AgentListScreen';
import { render } from '../../../ui/__tests__/render';
import { ToastProvider } from '../../../ui/Toast';

const item = (over: Partial<AgentListItem>): AgentListItem => ({
  id: 'agent',
  name: 'Agent',
  description: '',
  model: 'anthropic/claude-sonnet-5-5',
  enabled: true,
  labels: [],
  updatedAt: '2026-10-29T11:00:00Z',
  publishedVersion: null,
  counts: { tools: 0, mcpServers: 0, subagents: 0, triggers: 0 },
  ...over,
});

const wsItem = (over: Partial<WorkspaceAgentItem>): WorkspaceAgentItem => ({
  ...item({}),
  kind: 'workspace',
  workspaceId: 'alpha-1a2b3c',
  ...over,
});

const WSLIST: WorkspaceListItem[] = [
  { id: 'alpha-1a2b3c', name: 'Alpha', root: '/tmp/alpha', addedAt: '', lastOpenedAt: '', isLaunch: true, available: true, agentCount: 0 },
  { id: 'beta-2b3c4d', name: 'Beta', root: '/tmp/beta', addedAt: '', lastOpenedAt: '', isLaunch: false, available: true, agentCount: 0 },
];

const AGENTS_A: AgentListItem[] = [
  item({
    id: 'support-bot',
    name: 'Support bot',
    description: 'Answers billing questions.',
    labels: ['billing'],
    enabled: true,
    lastRun: { status: 'error', at: '2026-10-29T11:57:00Z', traceId: 't1' },
  }),
  item({ id: 'docs-qa', name: 'Docs QA', model: 'openai/gpt-5', enabled: true }),
];

/** The all-workspaces payload: A's agents plus a same-named one in B (ids repeat across workspaces). */
const ALL_ITEMS: WorkspaceAgentItem[] = [
  ...AGENTS_A.map((a) => wsItem({ ...a, workspaceId: 'alpha-1a2b3c' })),
  wsItem({ id: 'support-bot', name: 'Support bot', workspaceId: 'beta-2b3c4d', enabled: false }),
];

async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mountAt(hash = '#/agents') {
  window.history.replaceState(null, '', `/${hash}`);
  const host = render(
    <ToastProvider>
      <AgentListScreen />
    </ToastProvider>
  );
  await flush();
  return host;
}

const buttonNamed = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name);

/** A row of the New agent menu, which portals to document.body. */
const menuItemNamed = (name: string) =>
  [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
    el.textContent?.startsWith(name)
  );

const cardOf = (host: HTMLElement, name: string, ws?: string) =>
  [...host.querySelectorAll('article.agent-card')].find(
    (card) => card.textContent?.includes(name) && (ws === undefined || card.querySelector('.agent-card-workspace')?.textContent?.includes(ws))
  ) as HTMLElement;

const switchOf = (host: HTMLElement, name: string, ws?: string) =>
  cardOf(host, name, ws).querySelector<HTMLButtonElement>('[role="switch"]')!;

const toastTexts = (host: HTMLElement) =>
  [...host.querySelectorAll('.toast-message')].map((el) => el.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  wsState.list = WSLIST;
  wsState.launchId = 'alpha-1a2b3c';
  wsState.activeId = undefined;
  api.listAgents.mockResolvedValue(AGENTS_A);
  api.listAllAgentItems.mockResolvedValue({ items: ALL_ITEMS, skipped: [] });
  api.patchAgentMeta.mockResolvedValue({});
  api.createAgentRecord.mockResolvedValue({ id: 'untitled-1' } as AgentRecord);
  // forWorkspace(id) answers a client-shaped object whose methods record
  // the workspace id first, so tests can assert which workspace was hit.
  api.forWorkspace.mockImplementation((wsId: string) => ({
    listAgents: () => api.listAgents(wsId),
    patchAgentMeta: (id: string, patch: unknown) => api.patchAgentMeta(wsId, id, patch),
    createAgentRecord: (req: unknown) => api.createAgentRecord(wsId, req),
  }));
  window.history.replaceState(null, '', '/#/agents');
});

describe('AgentListScreen - all workspaces (#/agents)', () => {
  it('shows six skeleton cards and a loading status while the list is pending', async () => {
    api.listAllAgentItems.mockReturnValue(new Promise(() => {}));
    const host = render(
      <ToastProvider>
        <AgentListScreen />
      </ToastProvider>
    );
    await flush();
    expect(host.querySelectorAll('.agent-card-skeleton')).toHaveLength(6);
    const grid = host.querySelector('ul.agent-grid')!;
    expect(grid.getAttribute('aria-busy')).toBe('true');
    expect(grid.querySelector('[role="status"]')?.textContent).toBe('Loading agents');
  });

  it('lists every workspace\'s agents, each card with its workspace chip', async () => {
    const host = await mountAt();
    expect(api.listAllAgentItems).toHaveBeenCalledTimes(1);
    expect(api.listAgents).not.toHaveBeenCalled();
    expect(host.querySelectorAll('article.agent-card')).toHaveLength(3);
    const chip = cardOf(host, 'Support bot', 'Beta').querySelector('.agent-card-workspace');
    expect(chip?.textContent).toContain('Beta');
    expect(chip?.getAttribute('title')).toBe('/tmp/beta');
    expect(host.textContent).toContain('Every agent in every workspace.');
  });

  it('shows the Workspace facet and narrows by ?workspace=<id>', async () => {
    const host = await mountAt('#/agents?workspace=beta-2b3c4d');
    const facet = host.querySelector('.filter-bar, [class*="facet"]');
    expect(facet).not.toBeNull();
    // Only B's agent survives the workspace filter.
    expect(host.querySelectorAll('article.agent-card')).toHaveLength(1);
    expect(cardOf(host, 'Support bot', 'Beta')).toBeDefined();
  });

  it('keeps both same-named agents and toggles only the targeted one', async () => {
    const host = await mountAt();
    const cards = host.querySelectorAll('article.agent-card');
    expect(cards).toHaveLength(3);
    const sw = switchOf(host, 'Support bot', 'Beta');
    await act(async () => sw.click());
    await flush();
    // B's support-bot starts disabled, so the switch turns it ON.
    expect(api.patchAgentMeta).toHaveBeenCalledWith('beta-2b3c4d', 'support-bot', { enabled: true });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(toastTexts(host)).toContain('“Support bot” is on');
  });

  it('opens a card on its own workspace\'s overview route', async () => {
    const host = await mountAt();
    const link = cardOf(host, 'Docs QA', 'Alpha').querySelector<HTMLAnchorElement>('.agent-card-link')!;
    expect(link.getAttribute('href')).toBe('#/w/alpha-1a2b3c/agents/docs-qa/overview');
    await act(async () => link.click());
    await flush();
    expect(window.location.hash).toBe('#/w/alpha-1a2b3c/agents/docs-qa/overview');
  });

  it('shows the skipped-workspaces note with a Settings link', async () => {
    api.listAllAgentItems.mockResolvedValue({
      items: ALL_ITEMS,
      skipped: [{ workspaceId: 'beta-2b3c4d', reason: 'Folder not found' }],
    });
    const host = await mountAt();
    const note = host.querySelector('.agent-list-skipped');
    expect(note?.textContent).toContain('Some workspaces could not be read: Beta.');
    expect(note?.querySelector('a')?.getAttribute('href')).toBe('#/settings');
  });

  it('creates a blank agent in the single selected Workspace filter, else the launch workspace', async () => {
    const host = await mountAt('#/agents?workspace=beta-2b3c4d');
    await act(async () => buttonNamed(host, 'New agent')!.click());
    await flush();
    await act(async () => menuItemNamed('Blank agent')!.click());
    await flush();
    expect(api.createAgentRecord).toHaveBeenCalledWith('beta-2b3c4d', { from: 'blank' });
    expect(window.location.hash).toBe('#/w/beta-2b3c4d/agents/untitled-1/canvas');
  });

  it('shows the error card on failure and Retry refetches', async () => {
    api.listAllAgentItems.mockRejectedValueOnce(new Error('boom'));
    const host = await mountAt();
    expect(host.textContent).toContain('Could not load agents');
    expect(host.textContent).toContain('boom');
    await act(async () => buttonNamed(host, 'Retry')!.click());
    await flush();
    expect(api.listAllAgentItems).toHaveBeenCalledTimes(2);
    expect(host.querySelectorAll('article.agent-card')).toHaveLength(3);
  });

  it('shows the empty state when no workspace has agents', async () => {
    api.listAllAgentItems.mockResolvedValue({ items: [], skipped: [] });
    const host = await mountAt();
    expect(host.textContent).toContain('No agents yet');
    expect(host.querySelectorAll('button.start-option')).toHaveLength(4);
  });

  it('shows the no-match state under a filter and Clear filters restores the cards', async () => {
    const host = await mountAt('#/agents?q=zzz');
    expect(host.textContent).toContain('No agents match these filters');
    await act(async () => buttonNamed(host, 'Clear filters')!.click());
    await flush();
    expect(window.location.hash).toBe('#/agents');
    expect(host.querySelectorAll('article.agent-card')).toHaveLength(3);
  });

  it('creates a blank agent in the launch workspace when no filter is set', async () => {
    const host = await mountAt();
    await act(async () => buttonNamed(host, 'New agent')!.click());
    await flush();
    await act(async () => menuItemNamed('Blank agent')!.click());
    await flush();
    expect(api.createAgentRecord).toHaveBeenCalledWith('alpha-1a2b3c', { from: 'blank' });
    expect(window.location.hash).toBe('#/w/alpha-1a2b3c/agents/untitled-1/canvas');
  });
});

describe('AgentListScreen - one workspace (#/w/<ws>/agents)', () => {
  it('lists only that workspace through forWorkspace, with no chips and scoped header copy', async () => {
    wsState.activeId = 'beta-2b3c4d';
    const host = await mountAt('#/w/beta-2b3c4d/agents');
    expect(api.forWorkspace).toHaveBeenCalledWith('beta-2b3c4d');
    expect(api.listAgents).toHaveBeenCalledWith('beta-2b3c4d');
    expect(api.listAllAgentItems).not.toHaveBeenCalled();
    expect(host.querySelectorAll('article.agent-card')).toHaveLength(2);
    expect(host.querySelector('.agent-card-workspace')).toBeNull();
    expect(host.textContent).toContain('Agents in Beta. Open one to edit it, test it and ship it.');
  });

  it('PATCHes meta through the item\'s workspace and navigates within it', async () => {
    const host = await mountAt('#/w/beta-2b3c4d/agents');
    const sw = switchOf(host, 'Support bot');
    await act(async () => sw.click());
    await flush();
    expect(api.patchAgentMeta).toHaveBeenCalledWith('beta-2b3c4d', 'support-bot', { enabled: false });
    const link = cardOf(host, 'Docs QA').querySelector<HTMLAnchorElement>('.agent-card-link')!;
    expect(link.getAttribute('href')).toBe('#/w/beta-2b3c4d/agents/docs-qa/overview');
  });

  it('creates a blank agent in the scoped workspace', async () => {
    const host = await mountAt('#/w/beta-2b3c4d/agents');
    await act(async () => buttonNamed(host, 'New agent')!.click());
    await flush();
    await act(async () => menuItemNamed('Blank agent')!.click());
    await flush();
    expect(api.createAgentRecord).toHaveBeenCalledWith('beta-2b3c4d', { from: 'blank' });
    expect(window.location.hash).toBe('#/w/beta-2b3c4d/agents/untitled-1/canvas');
  });
});
