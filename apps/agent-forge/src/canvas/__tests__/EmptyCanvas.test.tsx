import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Graph } from '../../graph/v2/types';

const appState = vi.hoisted(() => ({
  graph: { version: 2, nodes: [], emptySections: [], unplaced: [] } as unknown as Graph,
  spec: { version: 2, name: 'my-agent', model: 'mock/mock-1', instructions: '' },
  agentId: 'my-agent',
  setGraph: vi.fn(),
  setSelectedNodeId: vi.fn(),
  switchAgent: vi.fn(),
}));
vi.mock('../../state/AppState', () => ({
  // EmptyCanvas reads displayGraph (the proposal overlay's graph, C21);
  // these tests have no proposal, so it mirrors graph.
  useAppState: () => ({ ...appState, displayGraph: appState.graph }),
}));

import { render } from '../../ui/__tests__/render';
import { takePendingOpen } from '../../author/authorEntry';
import { EmptyCanvas } from '../EmptyCanvas';
import { AGENT_TEMPLATES } from '../templates';
import { specToGraph } from '../../graph/v2/specToGraph';

const rootOnly = (): Graph =>
  specToGraph({ version: 2, name: 'my-agent', model: 'mock/mock-1', instructions: '' });

beforeEach(() => {
  appState.graph = rootOnly();
  appState.setGraph.mockReset();
  appState.setSelectedNodeId.mockReset();
  appState.switchAgent.mockReset();
});

describe('EmptyCanvas', () => {
  it('lists every template, by name and description, when the graph is just the root agent', () => {
    const container = render(<EmptyCanvas />);
    for (const template of AGENT_TEMPLATES) {
      const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(template.name));
      expect(button?.textContent).toContain(template.description);
    }
  });

  it('steps aside while something is dragged, so a palette drop lands on the canvas', () => {
    const container = render(<EmptyCanvas />);
    act(() => {
      window.dispatchEvent(new Event('dragstart'));
    });
    expect(container.querySelector('.canvas-empty')).toBeNull();
    act(() => {
      window.dispatchEvent(new Event('dragend'));
    });
    expect(container.querySelector('.canvas-empty')).not.toBeNull();
  });

  it('renders nothing once the canvas has a capability node', () => {
    appState.graph = specToGraph({
      version: 2,
      name: 'my-agent',
      model: 'mock/mock-1',
      instructions: '',
      tools: [{ builtin: 'http' }],
    });
    const container = render(<EmptyCanvas />);
    expect(container.innerHTML).toBe('');
  });

  it('fills the canvas from the chosen template through setGraph, keeping the agent name', () => {
    const container = render(<EmptyCanvas />);
    const supportBot = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Support bot'))!;
    act(() => supportBot.click());
    expect(appState.setGraph).toHaveBeenCalledTimes(1);
    const next = appState.setGraph.mock.calls[0][0](appState.graph) as Graph;
    expect(next.nodes.map((n) => n.kind).sort()).toEqual(['agent', 'tool', 'trigger']);
    const agent = next.nodes.find((n) => n.id === 'agent');
    expect(agent?.kind === 'agent' && agent.data.fields.name).toBe('my-agent');
    expect(appState.setSelectedNodeId).toHaveBeenCalledWith('agent');
    expect(appState.switchAgent).not.toHaveBeenCalled();
  });

  it('has a primary action that starts the blank agent', () => {
    const container = render(<EmptyCanvas />);
    const primary = container.querySelector('.canvas-empty-action') as HTMLButtonElement;
    expect(primary.classList.contains('btn-primary')).toBe(true);
    expect(primary.textContent).toBe('Start with a blank agent');
    act(() => primary.click());
    const next = appState.setGraph.mock.calls[0][0](appState.graph) as Graph;
    expect(next.nodes.some((n) => n.kind === 'agent')).toBe(true);
    expect(next.nodes.some((n) => n.kind === 'tool')).toBe(false);
  });

  it('"Describe it to the Agent Author" queues an edit-focus open with a draft (AA19)', () => {
    takePendingOpen();
    const container = render(<EmptyCanvas />);
    const button = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Describe it to the Agent Author')
    )!;
    expect(button.classList.contains('btn-secondary')).toBe(true);
    act(() => button.click());
    expect(takePendingOpen()).toEqual({
      source: 'empty-canvas',
      focus: { mode: 'edit', agentId: 'my-agent' },
      draft: 'Build this agent so it ',
    });
    takePendingOpen();
  });
});
