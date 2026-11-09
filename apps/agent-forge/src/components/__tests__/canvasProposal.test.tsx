import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasLayout } from '../../../shared/wireTypes';
import { mergeProposal } from '../../graph/v2/proposal';
import { specToGraph } from '../../graph/v2/specToGraph';
import type { AgentSpecV2 } from '../../graph/v2/specTypes';
import type { Graph } from '../../graph/v2/types';

/** A layout recording every node's position — what AppState hands mergeProposal. */
function layoutOf(graph: Graph): CanvasLayout {
  const nodes: CanvasLayout['nodes'] = {};
  for (const n of graph.nodes) {
    if (n.kind === 'note') continue;
    nodes[n.id] = { x: n.position.x, y: n.position.y };
  }
  return { schemaVersion: 1, nodes, notes: [] };
}

const CURRENT = {
  version: 2,
  name: 'bot',
  model: 'mock/mock-1',
  instructions: 'x',
  tools: [{ builtin: 'http' }],
  guardrails: [{ id: 'g1', name: 'max-length', on: 'input' }],
  triggers: [{ id: 't1', type: 'chat' }],
  abortListeners: [{ id: 'a1', triggerId: 't1', when: 'event.x', match: 'run.y', scope: 'both' }],
} as unknown as AgentSpecV2;

/** Adds a tool, drops the guardrail, changes the model and an abort listener — 1 added, 2 changed, 1 removed. */
const PROPOSED = {
  ...CURRENT,
  model: 'openai/gpt-5',
  tools: [{ builtin: 'http' }, { builtin: 'web_fetch' }],
  guardrails: [],
  abortListeners: [{ id: 'a1', triggerId: 't1', when: 'event.changed', match: 'run.y', scope: 'both' }],
} as unknown as AgentSpecV2;

const appState = vi.hoisted(() => ({
  graph: undefined as unknown as Graph,
  displayGraph: undefined as unknown as Graph,
  proposal: undefined as unknown,
  hideProposal: vi.fn(),
  showProposal: vi.fn(),
  selectedNodeId: 'abort:a1' as string | undefined,
  setSelectedNodeId: vi.fn(),
  setGraph: vi.fn(),
  railTab: 'nodes',
  setRailTab: vi.fn(),
  agents: [],
  agentId: 'bot',
  agentStatuses: {},
  spec: { name: 'bot' },
  debugMode: false,
  debugState: undefined,
  setBreakpoints: vi.fn(async () => {}),
}));
vi.mock('../../state/AppState', () => ({ useAppState: () => appState }));

import { render } from '../../ui/__tests__/render';
import { ProposalBanner } from '../CanvasArea';
import { Inspector } from '../Inspector';
import { LeftRail } from '../LeftRail';
import { ReactFlowProvider } from '@xyflow/react';

beforeEach(() => {
  vi.clearAllMocks();
  appState.graph = specToGraph(CURRENT);
  appState.displayGraph = mergeProposal(appState.graph, PROPOSED, layoutOf(appState.graph));
  appState.proposal = { proposalId: 'p1', spec: PROPOSED, title: 'Tighten the bot' };
  appState.selectedNodeId = 'abort:a1';
  appState.railTab = 'nodes';
});

describe('ProposalBanner', () => {
  it('shows the counts and a Hide button that calls hideProposal', () => {
    const container = render(<ProposalBanner />);
    const banner = container.querySelector('.canvas-proposal-banner')!;
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.textContent).toContain('Showing a proposed change: 1 added, 2 changed, 1 removed.');
    const hide = [...banner.querySelectorAll('button')].find((b) => b.textContent === 'Hide')!;
    act(() => hide.click());
    expect(appState.hideProposal).toHaveBeenCalledTimes(1);
  });

  it('renders nothing without a proposal', () => {
    appState.proposal = undefined;
    const container = render(<ProposalBanner />);
    expect(container.querySelector('.canvas-proposal-banner')).toBeNull();
  });
});

describe('palette while a proposal is shown', () => {
  it('disables every entry with the "Hide the proposal to edit" tooltip', () => {
    const container = render(
      <ReactFlowProvider>
        <LeftRail />
      </ReactFlowProvider>
    );
    const items = [...container.querySelectorAll<HTMLButtonElement>('.node-palette-item')];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.getAttribute('aria-disabled')).toBe('true');
      expect(item.title).toBe('Hide the proposal to edit');
      expect(item.draggable).toBe(false);
    }
  });
});

describe('Inspector while a proposal is shown', () => {
  it('renders the fields disabled inside a fieldset with the proposal hint, showing proposed data', () => {
    const container = render(<Inspector />);
    const fieldset = container.querySelector('fieldset.inspector-proposal-fieldset') as HTMLFieldSetElement;
    expect(fieldset).not.toBeNull();
    expect(fieldset.disabled).toBe(true);
    expect(container.textContent).toContain('This is a proposal. Apply it from the chat to edit.');
    // 'abort:a1' is proposed:edit — the generic JSON editor shows the
    // PROPOSED `when`, not the current one.
    const textarea = container.querySelector('#node-json') as HTMLTextAreaElement;
    expect(JSON.parse(textarea.value)).toMatchObject({ id: 'a1', when: 'event.changed' });
  });
});
