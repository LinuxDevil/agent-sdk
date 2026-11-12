import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ScreenHeader renders inline here (no shell host); its live run status reads the app state.
vi.mock('../../../state/AppState', () => ({ useAppState: () => ({ runStatus: null }) }));

const api = vi.hoisted(() => ({
  listAgents: vi.fn(),
  patchAgentMeta: vi.fn(),
  createAgentRecord: vi.fn(),
}));
vi.mock('../../../runtime/runtimeClient', () => ({ runtimeClient: api }));

import type { AgentListItem, AgentRecord } from '../../../../shared/wireTypes';
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

const ITEMS: AgentListItem[] = [
  item({
    id: 'support-bot',
    name: 'Support bot',
    description: 'Answers billing questions.',
    labels: ['billing'],
    enabled: true,
    lastRun: { status: 'error', at: '2026-10-29T11:57:00Z', traceId: 't1' },
  }),
  item({
    id: 'pr-reviewer',
    name: 'PR reviewer',
    labels: ['github', 'billing'],
    enabled: false,
    model: 'anthropic/claude-opus-5',
  }),
  item({ id: 'docs-qa', name: 'Docs QA', model: 'openai/gpt-5', enabled: true }),
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

const cardOf = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll('article.agent-card')].find((card) => card.textContent?.includes(name)) as HTMLElement;

const switchOf = (host: HTMLElement, name: string) =>
  cardOf(host, name).querySelector<HTMLButtonElement>('[role="switch"]')!;

const toastTexts = (host: HTMLElement) =>
  [...host.querySelectorAll('.toast-message')].map((el) => el.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  api.listAgents.mockResolvedValue(ITEMS);
  api.patchAgentMeta.mockResolvedValue({});
  api.createAgentRecord.mockResolvedValue({ id: 'untitled-1' } as AgentRecord);
  window.history.replaceState(null, '', '/#/agents');
});

describe('AgentListScreen', () => {
  it('shows six skeleton cards and a loading status while the list is pending', async () => {
    api.listAgents.mockReturnValue(new Promise(() => {}));
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

  it('renders one card per agent and the count status', async () => {
    const host = await mountAt();
    expect(host.querySelectorAll('article.agent-card')).toHaveLength(3);
    const status = [...host.querySelectorAll('p[role="status"]')].find((el) => el.textContent === '3 agents');
    expect(status).toBeDefined();
  });

  it('shows the error card on failure and Retry refetches', async () => {
    api.listAgents.mockRejectedValueOnce(new Error('boom'));
    const host = await mountAt();
    expect(host.textContent).toContain('Could not load agents');
    expect(host.textContent).toContain('boom');
    await act(async () => buttonNamed(host, 'Retry')!.click());
    await flush();
    expect(api.listAgents).toHaveBeenCalledTimes(2);
    expect(host.querySelectorAll('article.agent-card')).toHaveLength(3);
  });

  it('shows the empty state with four start options when there are no agents', async () => {
    api.listAgents.mockResolvedValue([]);
    const host = await mountAt();
    expect(host.textContent).toContain('No agents yet');
    expect(host.textContent).toContain('Pick a way to start.');
    const options = host.querySelectorAll('button.start-option');
    expect(options).toHaveLength(4);
    expect([...options].map((b) => b.querySelector('.start-option-title')?.textContent)).toEqual([
      'Blank agent',
      'Describe with AI',
      'From template',
      'Import from file…',
    ]);
  });

  it('opens the import sheet from the empty state and from the New agent menu', async () => {
    api.listAgents.mockResolvedValue([]);
    const host = await mountAt();

    const importOption = [...host.querySelectorAll<HTMLButtonElement>('button.start-option')].find(
      (b) => b.querySelector('.start-option-title')?.textContent === 'Import from file…'
    )!;
    await act(async () => importOption.click());
    await flush();
    expect(document.querySelector('.sheet-title')?.textContent).toBe('Import an agent');
    await act(async () => document.querySelector<HTMLButtonElement>('.sheet-close')!.click());
    await flush();
    expect(document.querySelector('.sheet')).toBeNull();

    await act(async () => buttonNamed(host, 'New agent')!.click());
    await flush();
    await act(async () => menuItemNamed('Import from file…')!.click());
    await flush();
    expect(document.querySelector('.sheet-title')?.textContent).toBe('Import an agent');
  });

  it('shows the no-match state under a filter and Clear filters restores the URL and the cards', async () => {
    const host = await mountAt('#/agents?q=zzz');
    expect(host.textContent).toContain('No agents match these filters');
    await act(async () => buttonNamed(host, 'Clear filters')!.click());
    await flush();
    expect(window.location.hash).toBe('#/agents');
    expect(host.querySelectorAll('article.agent-card')).toHaveLength(3);
  });

  it('toggles a card optimistically and toasts on success', async () => {
    let resolvePatch!: (meta: unknown) => void;
    api.patchAgentMeta.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePatch = resolve;
        })
    );
    const host = await mountAt();
    const sw = switchOf(host, 'Support bot');
    expect(sw.getAttribute('aria-checked')).toBe('true');

    await act(async () => sw.click());
    expect(api.patchAgentMeta).toHaveBeenCalledWith('support-bot', { enabled: false });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(sw.disabled).toBe(true);

    await act(async () => resolvePatch({}));
    await flush();
    expect(sw.disabled).toBe(false);
    expect(toastTexts(host)).toContain('“Support bot” is off');
  });

  it('reverts the switch and toasts the server message when the PATCH fails', async () => {
    api.patchAgentMeta.mockRejectedValueOnce(new Error('meta is locked'));
    const host = await mountAt();
    const sw = switchOf(host, 'Support bot');

    await act(async () => sw.click());
    await flush();
    expect(api.patchAgentMeta).toHaveBeenCalledWith('support-bot', { enabled: false });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(sw.disabled).toBe(false);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('meta is locked');
  });

  it('shares one creating state between the header menu and the start options', async () => {
    api.listAgents.mockResolvedValue([]);
    let resolveCreate!: (record: AgentRecord) => void;
    api.createAgentRecord.mockReturnValue(
      new Promise<AgentRecord>((resolve) => {
        resolveCreate = resolve;
      })
    );
    const host = await mountAt();

    // Start the create from the empty state's Blank button.
    const blankOption = [...host.querySelectorAll<HTMLButtonElement>('button.start-option')].find(
      (b) => b.querySelector('.start-option-title')?.textContent === 'Blank agent'
    )!;
    await act(async () => blankOption.click());
    await flush();
    expect(api.createAgentRecord).toHaveBeenCalledTimes(1);
    expect(api.createAgentRecord).toHaveBeenCalledWith({ from: 'blank' });

    // The header trigger and the start option both reflect the same in-flight create,
    // so a second activation cannot issue a duplicate POST /agents.
    const trigger = host.querySelector<HTMLButtonElement>('.menu-trigger')!;
    expect(trigger.textContent).toContain('Creating…');
    expect(trigger.disabled).toBe(true);
    expect(blankOption.disabled).toBe(true);
    expect(blankOption.getAttribute('title')).toBe('Creating an agent…');

    await act(async () => resolveCreate({ id: 'untitled-1' } as AgentRecord));
    await flush();
    expect(api.createAgentRecord).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe('#/agents/untitled-1/canvas');
  });

  it('creates a blank agent from the New agent menu and opens its canvas', async () => {
    const host = await mountAt();
    await act(async () => buttonNamed(host, 'New agent')!.click());
    await flush();
    await act(async () => menuItemNamed('Blank agent')!.click());
    await flush();
    expect(api.createAgentRecord).toHaveBeenCalledWith({ from: 'blank' });
    expect(window.location.hash).toBe('#/agents/untitled-1/canvas');
  });
});
