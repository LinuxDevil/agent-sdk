import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGraphSpec } from '../../graph/types';

const appState = vi.hoisted(() => ({
  graph: { version: 1, nodes: [], edges: [] } as AgentGraphSpec,
  spec: { name: 'my-agent', prompt: '', provider: { type: 'mock', model: 'mock-1' } },
  setGraph: vi.fn(),
  setSelectedNodeId: vi.fn(),
  switchAgent: vi.fn(),
}));
vi.mock('../../state/AppState', () => ({ useAppState: () => appState }));

import { render } from '../../ui/__tests__/render';
import { EmptyCanvas } from '../EmptyCanvas';
import { AGENT_TEMPLATES } from '../templates';
import { specToGraph } from '../../graph/specToGraph';

beforeEach(() => {
  appState.graph = { version: 1, nodes: [], edges: [] };
  appState.setGraph.mockReset();
  appState.setSelectedNodeId.mockReset();
  appState.switchAgent.mockReset();
});

describe('EmptyCanvas', () => {
  it('lists every template, by name and description, when the graph has no nodes', () => {
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

  it('renders nothing once the canvas has a node', () => {
    appState.graph = specToGraph(appState.spec);
    const container = render(<EmptyCanvas />);
    expect(container.innerHTML).toBe('');
  });

  it('fills the canvas from the chosen template through setGraph, keeping the agent name', () => {
    const container = render(<EmptyCanvas />);
    const supportBot = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Support bot'))!;
    act(() => supportBot.click());
    expect(appState.setGraph).toHaveBeenCalledTimes(1);
    const next = appState.setGraph.mock.calls[0][0](appState.graph) as AgentGraphSpec;
    expect(next.nodes.map((n) => n.type).sort()).toEqual(['llm', 'output', 'tool', 'trigger']);
    const llm = next.nodes.find((n) => n.type === 'llm');
    expect(llm?.type === 'llm' && llm.data.name).toBe('my-agent');
    expect(appState.setSelectedNodeId).toHaveBeenCalledWith(llm?.id);
    expect(appState.switchAgent).not.toHaveBeenCalled();
  });
});
