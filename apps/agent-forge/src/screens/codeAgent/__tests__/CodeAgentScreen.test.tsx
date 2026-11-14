import { act } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReactFlowProvider } from '@xyflow/react';

// jsdom has no ResizeObserver; React Flow's pane needs one to mount (a no-op
// stub leaves every box at 0x0, which is all these tests assert on).
beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

// ScreenHeader's live run status reads the app state; node kind Fields may too.
vi.mock('../../../state/AppState', () => ({
  useAppState: () => ({
    runStatus: undefined,
    agents: [],
    agentId: '',
    debugMode: false,
    debugState: undefined,
    spans: [],
    pins: [],
    problems: [],
    specPaths: {},
    openNodeSpans: () => {},
    setBreakpoints: async () => {},
  }),
}));

const api = vi.hoisted(() => ({
  loadCodeAgentSpec: vi.fn(),
  importAgent: vi.fn(),
  forWorkspace: vi.fn(),
}));
vi.mock('../../../runtime/runtimeClient', async (importActual) => {
  const actual = await importActual<typeof import('../../../runtime/runtimeClient')>();
  return { ...actual, runtimeClient: api };
});

// elkjs stays out of jsdom: the screen's layout step is identity here.
vi.mock('../../../canvas/layout', async (importActual) => {
  const actual = await importActual<typeof import('../../../canvas/layout')>();
  return { ...actual, autoLayout: vi.fn(async (graph: unknown) => graph) };
});

import type { AgentSpecV2 } from 'lousho';
import type { AgentRecord } from '../../../../shared/wireTypes';
import { RuntimeApiError } from '../../../runtime/runtimeClient';
import { CodeAgentScreen } from '../CodeAgentScreen';
import { render } from '../../../ui/__tests__/render';
import { ToastProvider } from '../../../ui/Toast';

const SPEC: AgentSpecV2 = {
  version: 2,
  name: 'Support bot',
  description: 'Answers billing questions.',
  model: 'mock/echo',
  instructions: 'Be helpful.',
  tools: [{ builtin: 'http' }],
} as AgentSpecV2;

const WS = 'beta-2b3c4d';

async function flush() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function mount(path = 'agents/support', workspaceId = WS) {
  window.history.replaceState(null, '', '/#/agents');
  return render(
    <ReactFlowProvider>
      <ToastProvider>
        <CodeAgentScreen workspaceId={workspaceId} path={path} />
      </ToastProvider>
    </ReactFlowProvider>
  );
}

const buttonNamed = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/#/agents');
  // Every screen call goes through forWorkspace(ws): the scoped client
  // answers the spec load and the import.
  api.forWorkspace.mockImplementation(() => ({
    loadCodeAgentSpec: api.loadCodeAgentSpec,
    importAgent: api.importAgent,
  }));
});

describe('CodeAgentScreen', () => {
  it('loads the spec through forWorkspace(ws) and renders the banner, header and canvas nodes', async () => {
    api.loadCodeAgentSpec.mockResolvedValue({ path: 'agents/support', spec: SPEC, warnings: [] });
    const host = mount();
    await flush();

    expect(api.forWorkspace).toHaveBeenCalledWith(WS);
    expect(api.loadCodeAgentSpec).toHaveBeenCalledWith('agents/support');
    expect(host.querySelector('.page-header')?.textContent).toContain('Support bot');
    expect(host.querySelector('.page-header')?.textContent).toContain('Answers billing questions.');
    const banner = host.querySelector('.code-agent-banner')!;
    expect(banner.textContent).toContain('Defined in code at');
    expect(banner.querySelector('code')?.textContent).toBe('agents/support');
    expect(banner.textContent).toContain('Edit the files to change it.');
    // The spec's nodes are on the canvas: the root agent and its tool.
    expect(host.querySelectorAll('.rf-node').length).toBeGreaterThanOrEqual(2);
    expect(buttonNamed(host, 'Copy into Studio')).toBeDefined();
    // No warnings -> no warnings list.
    expect(host.querySelector('.code-agent-warnings')).toBeNull();
  });

  it('breadcrumbs link back to the workspace\'s agent list and show the workspace chip', async () => {
    api.loadCodeAgentSpec.mockResolvedValue({ path: 'agents/support', spec: SPEC, warnings: [] });
    const host = mount();
    await flush();

    const crumbs = [...host.querySelectorAll('.page-header a, .breadcrumbs a, nav a')];
    const agentsLink = crumbs.find((a) => a.textContent === 'Agents');
    expect(agentsLink?.getAttribute('href')).toBe(`#/w/${WS}/agents`);
    // No workspace list is loaded in this test, so the chip falls back to the id.
    expect(host.querySelector('.page-header .chip')?.textContent).toContain(WS);
  });

  it('lists the load warnings only when there are some', async () => {
    api.loadCodeAgentSpec.mockResolvedValue({
      path: 'agents/support',
      spec: SPEC,
      warnings: ['tools[0]: unknown field dropped'],
    });
    const host = mount();
    await flush();
    const items = [...host.querySelectorAll('.code-agent-warnings li')].map((li) => li.textContent);
    expect(items).toEqual(['tools[0]: unknown field dropped']);
  });

  it('shows the not-found state on a 404, with a back link into the workspace', async () => {
    api.loadCodeAgentSpec.mockRejectedValue(new RuntimeApiError('Agent directory not found', 404));
    const host = mount('agents/gone');
    await flush();
    expect(host.textContent).toContain('Agent directory not found');
    expect(host.textContent).toContain('It may have been moved or deleted.');
    const back = host.querySelector<HTMLAnchorElement>('.empty-state-action a');
    expect(back?.getAttribute('href')).toBe(`#/w/${WS}/agents`);
    expect(back?.textContent).toBe('Back to agents');
  });

  it('shows the read-error state with the server message on a 422', async () => {
    api.loadCodeAgentSpec.mockRejectedValue(
      new RuntimeApiError('agent.ts is a code config and cannot be read as a spec', 422)
    );
    const host = mount('agents/support');
    await flush();
    expect(host.textContent).toContain('Could not read this agent');
    expect(host.textContent).toContain('agent.ts is a code config and cannot be read as a spec');
  });

  it('copies the spec into the SAME workspace and opens its canvas there', async () => {
    api.loadCodeAgentSpec.mockResolvedValue({ path: 'agents/support', spec: SPEC, warnings: [] });
    api.importAgent.mockResolvedValue({ id: 'support-bot-copy' } as AgentRecord);
    const host = mount();
    await flush();

    await act(async () => buttonNamed(host, 'Copy into Studio')!.click());
    await flush();

    expect(api.forWorkspace).toHaveBeenCalledWith(WS);
    expect(api.importAgent).toHaveBeenCalledTimes(1);
    const request = api.importAgent.mock.calls[0][0] as { text: string; mode: string };
    expect(request.mode).toBe('new');
    expect(request.text).toContain('Support bot');
    expect(window.location.hash).toBe(`#/w/${WS}/agents/support-bot-copy/canvas`);
    const toast = [...host.querySelectorAll('.toast-message')].map((el) => el.textContent);
    expect(toast).toContain('Copied as support-bot-copy. Changes in Studio do not touch the files.');
  });

  it('toasts the error and stays put when the copy fails', async () => {
    api.loadCodeAgentSpec.mockResolvedValue({ path: 'agents/support', spec: SPEC, warnings: [] });
    api.importAgent.mockRejectedValue(new Error('import refused'));
    const host = mount();
    await flush();

    await act(async () => buttonNamed(host, 'Copy into Studio')!.click());
    await flush();

    expect(window.location.hash).toBe('#/agents');
    const toast = [...host.querySelectorAll('.toast-message')].map((el) => el.textContent);
    expect(toast).toContain('import refused');
  });
});
