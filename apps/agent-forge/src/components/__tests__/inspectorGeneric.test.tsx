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
 * A `flow` node with an editor-only step `type`: `FlowStepFields` keeps
 * the generic JSON editor of `data.step` for types it has no form for
 * (C25), so this exercises the generic Inspector even though the kind
 * itself is registered (C15).
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
        data: { step: { type: 'mystery', id: 'e1' }, children: { shape: 'none' } },
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
    expect(container.querySelector('.inspector-head .k')?.textContent).toBe('Selected node (Flow step)');
    // The flow view titles a card by its step type label; unknown types show the raw type.
    expect(container.querySelector('.inspector-head .v')?.textContent).toBe('mystery');
    const textarea = container.querySelector('#node-json') as HTMLTextAreaElement;
    expect(JSON.parse(textarea.value)).toEqual({ type: 'mystery', id: 'e1' });
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
