import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSpec } from 'lousho';
import type { AgentGraphSpec } from '../../graph/types';

const appState = vi.hoisted(() => ({
  graph: { version: 1, nodes: [], edges: [] } as AgentGraphSpec,
  setGraph: vi.fn(),
}));
vi.mock('../../state/AppState', () => ({ useAppState: () => appState }));

import { render } from '../../ui/__tests__/render';
import { RetainedFlowNotice } from '../CanvasArea';
import { specToGraph } from '../../graph/specToGraph';

const flowSpec: AgentSpec = {
  name: 'flow-agent',
  prompt: 'Do the thing.',
  provider: { type: 'mock', model: 'mock-1' },
  policy: { flow: { name: 'saved-flow', code: 'flow-agent', flow: { type: 'sequence', steps: [] } } },
};

const confirm = vi.hoisted(() => vi.fn());

beforeEach(() => {
  appState.graph = specToGraph(flowSpec);
  appState.setGraph.mockReset();
  confirm.mockReset();
  window.confirm = confirm;
});

describe('RetainedFlowNotice', () => {
  it('tells the user a saved flow still runs but cannot be drawn', () => {
    const container = render(<RetainedFlowNotice />);
    const notice = container.querySelector('.canvas-notice');
    expect(notice?.getAttribute('role')).toBe('status');
    expect(notice?.textContent).toContain("saved flow the canvas can't show yet. It still runs.");
    expect(notice?.querySelector('button')?.textContent).toBe('Remove flow');
  });

  it('Remove flow confirms, then clears retainedFlow through setGraph', () => {
    confirm.mockReturnValue(true);
    const container = render(<RetainedFlowNotice />);
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Remove flow')!;
    act(() => button.click());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(appState.setGraph).toHaveBeenCalledTimes(1);
    const next = appState.setGraph.mock.calls[0][0](appState.graph) as AgentGraphSpec;
    expect(next.retainedFlow).toBeUndefined();
    expect(next.nodes).toBe(appState.graph.nodes);
  });

  it('does nothing when the removal is not confirmed', () => {
    confirm.mockReturnValue(false);
    const container = render(<RetainedFlowNotice />);
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Remove flow')!;
    act(() => button.click());
    expect(appState.setGraph).not.toHaveBeenCalled();
  });

  it('stays hidden while a router node exists (the canvas draws the flow itself)', () => {
    appState.graph.nodes.push({
      id: 'router-1',
      type: 'router',
      position: { x: 0, y: 0 },
      label: 'Router',
      data: {},
    });
    const container = render(<RetainedFlowNotice />);
    expect(container.querySelector('.canvas-notice')).toBeNull();
  });

  it('stays hidden when the graph has no retained flow', () => {
    appState.graph = { ...appState.graph, retainedFlow: undefined };
    const container = render(<RetainedFlowNotice />);
    expect(container.querySelector('.canvas-notice')).toBeNull();
  });
});
