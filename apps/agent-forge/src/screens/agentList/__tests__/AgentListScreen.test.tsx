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
  workspaceScan: vi.fn(),
  scanWorkspace: vi.fn(),
  hostStatus: vi.fn(),
  restartHost: vi.fn(),
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

import type { AgentListItem, AgentRecord, CodeAgentItem, ObservedAgentItem, WorkspaceAgentItem, WorkspaceListItem } from '../../../../shared/wireTypes';
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

const obsItem = (over: Partial<ObservedAgentItem>): ObservedAgentItem => ({
  kind: 'observed',
  id: 'daemon-uuid-1',
  name: 'billing-worker',
  project: 'billing-svc',
  workspaceId: 'alpha-1a2b3c',
  instances: 2,
  status: 'healthy',
  lastSeenAt: '2026-10-29T11:58:00Z',
  runsToday: 14,
  errorRateToday: 0.02,
  ...over,
});

const WSLIST: WorkspaceListItem[] = [
  { id: 'alpha-1a2b3c', name: 'Alpha', root: '/tmp/alpha', addedAt: '', lastOpenedAt: '', isLaunch: true, available: true, agentCount: 0, observeProject: 'default' },
  { id: 'beta-2b3c4d', name: 'Beta', root: '/tmp/beta', addedAt: '', lastOpenedAt: '', isLaunch: false, available: true, agentCount: 0, observeProject: 'default' },
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
  api.listAllAgentItems.mockResolvedValue({ items: ALL_ITEMS, skipped: [], observed: 'ok' });
  api.patchAgentMeta.mockResolvedValue({});
  api.createAgentRecord.mockResolvedValue({ id: 'untitled-1' } as AgentRecord);
  api.workspaceScan.mockResolvedValue({ workspaceId: 'beta-2b3c4d', scannedAt: '', patterns: [], agents: [] });
  api.scanWorkspace.mockResolvedValue({ workspaceId: 'beta-2b3c4d', scannedAt: '', patterns: [], agents: [] });
  // forWorkspace(id) answers a client-shaped object whose methods record
  // the workspace id first, so tests can assert which workspace was hit.
  api.forWorkspace.mockImplementation((wsId: string) => ({
    listAgents: () => api.listAgents(wsId),
    patchAgentMeta: (id: string, patch: unknown) => api.patchAgentMeta(wsId, id, patch),
    createAgentRecord: (req: unknown) => api.createAgentRecord(wsId, req),
    // W11c host banner: no status resolves -> the banner renders nothing.
    subscribeEvents: () => () => undefined,
    hostStatus: () => api.hostStatus(wsId),
  }));
  api.hostStatus.mockRejectedValue(new Error('no host status in this test'));
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
      observed: 'ok',
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
    api.listAllAgentItems.mockResolvedValue({ items: [], skipped: [], observed: 'ok' });
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
    // W07b: workspace mode also reads the aggregate - but only for the
    // observed items placed in THIS workspace.
    expect(api.listAllAgentItems).toHaveBeenCalledTimes(1);
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

describe('AgentListScreen - observed agents (W07b)', () => {
  const OBSERVED: ObservedAgentItem[] = [
    obsItem({ id: 'obs-a1', name: 'billing-worker', workspaceId: 'alpha-1a2b3c' }),
    obsItem({ id: 'obs-ci', name: 'nightly', project: 'ci', workspaceId: null, instances: 1, runsToday: 3 }),
  ];
  const payload = (items: unknown[] = [...ALL_ITEMS, ...OBSERVED], observed: 'ok' | 'unavailable' = 'ok') => ({
    items,
    skipped: [],
    observed,
  });

  it('places a workspace-matched observed card after the workspace agents and an unmatched one under Elsewhere', async () => {
    api.listAllAgentItems.mockResolvedValue(payload());
    const host = await mountAt();
    const cards = [...host.querySelectorAll('article.agent-card')];
    // 3 workspace cards, then the placed observed card, then the Elsewhere one.
    expect(cards).toHaveLength(5);
    expect(cards[3].className).toContain('agent-card--observed');
    expect(cards[3].textContent).toContain('billing-worker');
    expect(cards[3].textContent).toContain('Alpha');
    const elsewhere = host.querySelector('h2.agent-list-group');
    expect(elsewhere?.textContent).toBe('Elsewhere');
    expect(host.querySelector('.agent-list-group-hint')?.textContent).toContain('not in Studio');
    const elsewhereGrid = [...host.querySelectorAll('ul.agent-grid')].at(-1)!;
    expect(elsewhereGrid.textContent).toContain('nightly');
    expect(elsewhereGrid.textContent).toContain('ci');
  });

  it('observed cards have no switch, link to #/observed/<id>, and announce "observed agent"', async () => {
    api.listAllAgentItems.mockResolvedValue(payload());
    const host = await mountAt();
    const card = [...host.querySelectorAll('article.agent-card--observed')].find((c) => c.textContent?.includes('billing-worker'))!;
    expect(card.querySelector('[role="switch"]')).toBeNull();
    const link = card.querySelector<HTMLAnchorElement>('.agent-card-link')!;
    expect(link.getAttribute('href')).toBe('#/observed/obs-a1');
    expect(link.getAttribute('aria-label')).toBe('billing-worker, observed agent');
    expect(card.textContent).toContain('2 instances');
    expect(card.textContent).toContain('Observed');
    expect(card.textContent).toContain('Healthy');
    expect(card.textContent).toContain('14 runs today');
  });

  it('shows the collector note when observed is unavailable and still renders workspace agents', async () => {
    api.listAllAgentItems.mockResolvedValue(payload(ALL_ITEMS, 'unavailable'));
    const host = await mountAt();
    const note = [...host.querySelectorAll('.agent-list-skipped')].find((n) => n.textContent?.includes('collector'));
    expect(note?.textContent).toContain('The collector is not running, so agents deployed elsewhere are not shown.');
    expect(host.querySelectorAll('article.agent-card')).toHaveLength(3);
  });

  it('search matches an observed card by project', async () => {
    api.listAllAgentItems.mockResolvedValue(payload());
    const host = await mountAt('#/agents?q=nightly');
    // Only the Elsewhere card survives; the placed one and workspace agents are filtered out.
    expect(host.querySelectorAll('article.agent-card--observed')).toHaveLength(1);
    expect(host.textContent).toContain('nightly');
  });

  it('the Workspace filter hides Elsewhere and keeps matching placed cards', async () => {
    api.listAllAgentItems.mockResolvedValue(payload());
    const host = await mountAt('#/agents?workspace=alpha-1a2b3c');
    const observed = [...host.querySelectorAll('article.agent-card--observed')];
    expect(observed).toHaveLength(1);
    expect(observed[0].textContent).toContain('billing-worker');
    expect(host.querySelector('h2.agent-list-group')).toBeNull();
  });

  it('workspace mode shows only that workspace\'s observed items, with no workspace chip', async () => {
    wsState.activeId = 'alpha-1a2b3c';
    api.listAllAgentItems.mockResolvedValue(
      payload([
        obsItem({ id: 'obs-a1', name: 'billing-worker', workspaceId: 'alpha-1a2b3c' }),
        obsItem({ id: 'obs-b1', name: 'other', workspaceId: 'beta-2b3c4d' }),
        obsItem({ id: 'obs-x', name: 'nowhere', workspaceId: null }),
      ])
    );
    const host = await mountAt('#/w/alpha-1a2b3c/agents');
    const observed = [...host.querySelectorAll('article.agent-card--observed')];
    expect(observed).toHaveLength(1);
    expect(observed[0].textContent).toContain('billing-worker');
    expect(observed[0].querySelector('.agent-card-workspace')).toBeNull();
    expect(host.querySelector('h2.agent-list-group')).toBeNull();
  });
});

describe('AgentListScreen - code agents (W08b)', () => {
  const codeItem = (over: Partial<CodeAgentItem> = {}): CodeAgentItem => ({
    kind: 'code',
    id: 'agents/support',
    name: 'support',
    workspaceId: 'alpha-1a2b3c',
    configFile: 'agent.ts',
    configKind: 'code',
    ...over,
  });

  it('all mode renders code items as "In code" cards after the workspace and observed agents', async () => {
    api.listAllAgentItems.mockResolvedValue({
      items: [
        ...ALL_ITEMS,
        obsItem({ id: 'obs-a1', name: 'billing-worker', workspaceId: 'alpha-1a2b3c' }),
        codeItem(),
        codeItem({ id: 'src/agents/billing', name: 'billing', configFile: 'agent.yaml', configKind: 'data' }),
      ],
      skipped: [],
      observed: 'ok',
    });
    const host = await mountAt();
    const cards = [...host.querySelectorAll('article.agent-card')];
    // 3 workspace + 1 observed + 2 code.
    expect(cards).toHaveLength(6);
    const codeCards = cards.filter((c) => c.className.includes('agent-card--code'));
    expect(codeCards).toHaveLength(2);
    // Code cards come after the workspace and observed cards.
    expect(cards[4].className).toContain('agent-card--code');
    expect(cards[5].className).toContain('agent-card--code');
    const first = codeCards[0];
    expect(first.textContent).toContain('In code');
    expect(first.textContent).toContain('agents/support');
    expect(first.textContent).toContain('agent.ts');
    expect(first.textContent).toContain('Alpha');
    expect(first.textContent).toContain('Read-only. Edit the files to change it.');
    const link = first.querySelector<HTMLAnchorElement>('.agent-card-link')!;
    expect(link.getAttribute('href')).toBe('#/w/alpha-1a2b3c/code-agents/agents%2Fsupport');
    expect(link.getAttribute('aria-label')).toBe('support, defined in code');
    expect(first.querySelector('[role="switch"]')).toBeNull();
    // No Rescan action in all-workspaces mode.
    expect(buttonNamed(host, 'Rescan code')).toBeUndefined();
  });

  it('workspace mode loads code agents through workspaceScan and maps them to cards', async () => {
    wsState.activeId = 'beta-2b3c4d';
    api.workspaceScan.mockResolvedValue({
      workspaceId: 'beta-2b3c4d',
      scannedAt: '2026-10-29T12:00:00Z',
      patterns: ['agents/*/'],
      agents: [
        { path: 'agents/helper', name: 'helper', configFile: 'agent.yaml', configKind: 'data' },
        // 'support-bot' collides with a Studio agent id -> deduped (W08a rule).
        { path: 'agents/support-bot', name: 'support-bot', configFile: 'agent.ts', configKind: 'code' },
      ],
    });
    const host = await mountAt('#/w/beta-2b3c4d/agents');
    expect(api.workspaceScan).toHaveBeenCalledWith('beta-2b3c4d');
    const codeCards = [...host.querySelectorAll('article.agent-card--code')];
    expect(codeCards).toHaveLength(1);
    expect(codeCards[0].textContent).toContain('helper');
    expect(codeCards[0].textContent).toContain('agents/helper');
    expect(codeCards[0].querySelector('.agent-card-workspace')).toBeNull();
    expect(codeCards[0].querySelector<HTMLAnchorElement>('.agent-card-link')!.getAttribute('href')).toBe(
      '#/w/beta-2b3c4d/code-agents/agents%2Fhelper'
    );
  });

  it('Rescan code POSTs the scan, swaps in the new code items and toasts the count', async () => {
    wsState.activeId = 'beta-2b3c4d';
    api.scanWorkspace.mockResolvedValue({
      workspaceId: 'beta-2b3c4d',
      scannedAt: '2026-10-29T12:05:00Z',
      patterns: ['agents/*/'],
      agents: [
        { path: 'agents/helper', name: 'helper', configFile: 'agent.yaml', configKind: 'data' },
        { path: 'agents/newcomer', name: 'newcomer', configFile: 'agent.ts', configKind: 'code' },
      ],
    });
    const host = await mountAt('#/w/beta-2b3c4d/agents');
    const button = buttonNamed(host, 'Rescan code')!;
    expect(button).toBeDefined();
    await act(async () => button.click());
    await flush();
    expect(api.scanWorkspace).toHaveBeenCalledWith('beta-2b3c4d');
    const codeCards = [...host.querySelectorAll('article.agent-card--code')];
    expect(codeCards).toHaveLength(2);
    expect(host.textContent).toContain('newcomer');
    expect(toastTexts(host)).toContain('Found 2 code agents in Beta.');
  });

  it('Rescan code toasts "Found 1 code agent" for a single result', async () => {
    wsState.activeId = 'beta-2b3c4d';
    api.scanWorkspace.mockResolvedValue({
      workspaceId: 'beta-2b3c4d',
      scannedAt: '',
      patterns: [],
      agents: [{ path: 'agents/solo', name: 'solo', configFile: 'agent.ts', configKind: 'code' }],
    });
    const host = await mountAt('#/w/beta-2b3c4d/agents');
    await act(async () => buttonNamed(host, 'Rescan code')!.click());
    await flush();
    expect(toastTexts(host)).toContain('Found 1 code agent in Beta.');
  });

  it('Rescan code shows "Scanning…" while pending and toasts the server error on failure', async () => {
    wsState.activeId = 'beta-2b3c4d';
    let rejectScan: (e: Error) => void = () => {};
    api.scanWorkspace.mockReturnValue(new Promise((_, reject) => (rejectScan = reject)));
    const host = await mountAt('#/w/beta-2b3c4d/agents');
    const button = buttonNamed(host, 'Rescan code')!;
    await act(async () => button.click());
    await flush();
    expect(buttonNamed(host, 'Scanning…')).toBeDefined();
    await act(async () => rejectScan(new Error('scan exploded')));
    await flush();
    expect(toastTexts(host)).toContain('scan exploded');
    expect(buttonNamed(host, 'Rescan code')).toBeDefined();
  });
});
