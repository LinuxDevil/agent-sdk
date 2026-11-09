import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../../ui/__tests__/render';
import type { FlowNodeData, Graph, GraphNode } from '../../graph/v2/types';

const appState = vi.hoisted(() => ({
  graph: { version: 2, nodes: [], emptySections: [], unplaced: [] } as unknown as Graph,
  setGraph: vi.fn(),
  selectedNodeId: undefined as string | undefined,
  debugMode: false,
  debugState: undefined,
  setBreakpoints: vi.fn(async () => {}),
}));
vi.mock('../../state/AppState', () => ({
  // The Inspector reads displayGraph (the proposal overlay's graph, C21);
  // these tests have no proposal, so it mirrors graph.
  useAppState: () => ({ ...appState, displayGraph: appState.graph }),
}));

import { Inspector } from '../Inspector';

/**
 * A `flow` node built by hand — specToGraph does not emit flow nodes yet
 * (C15), and `flow` is the one kind still on the generic view, so it is the
 * only kind whose Inspector falls back to the JSON editor.
 */
const baseGraph = (): Graph =>
  ({
    version: 2,
    nodes: [
      {
        id: 'flow:e1',
        kind: 'flow',
        owner: 'agent',
        position: { x: 0, y: 0 },
        data: { step: { type: 'end', id: 'e1' }, children: { shape: 'none' } },
      } satisfies GraphNode,
    ],
    emptySections: [],
    unplaced: [],
  }) as Graph;

beforeEach(() => {
  appState.graph = baseGraph();
  appState.selectedNodeId = 'flow:e1';
  appState.setGraph.mockReset();
});

/** Fire a change + blur on the JSON textarea with `value`. */
function editJson(container: HTMLElement, value: string) {
  const textarea = container.querySelector('#node-json') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => {
    textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

describe('generic Inspector', () => {
  it('shows the selected node header and the JSON editor seeded with its item', () => {
    const container = render(<Inspector />);
    expect(container.querySelector('.inspector-head .k')?.textContent).toBe('Selected node (flow)');
    expect(container.querySelector('.inspector-head .v')?.textContent).toBe('e1');
    const textarea = container.querySelector('#node-json') as HTMLTextAreaElement;
    expect(JSON.parse(textarea.value)).toEqual({ type: 'end', id: 'e1' });
    expect(container.textContent).toContain('This node has no form yet.');
  });

  it('a valid JSON edit on blur calls setGraph and changes the node data', () => {
    const container = render(<Inspector />);
    editJson(container, '{ "type": "string" }');
    expect(appState.setGraph).toHaveBeenCalledTimes(1);
    const next = appState.setGraph.mock.calls[0][0](appState.graph) as Graph;
    const output = next.nodes.find((n) => n.id === 'flow:e1')!;
    expect((output.data as FlowNodeData).step).toEqual({ type: 'string' });
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('an invalid JSON edit shows the alert and does not call setGraph', () => {
    const container = render(<Inspector />);
    editJson(container, '{ not json');
    expect(appState.setGraph).not.toHaveBeenCalled();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('This is not valid JSON:');
  });
});
