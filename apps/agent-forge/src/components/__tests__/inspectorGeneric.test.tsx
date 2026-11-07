import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../../ui/__tests__/render';
import { specToGraph } from '../../graph/v2/specToGraph';
import type { AbortNodeData, Graph } from '../../graph/v2/types';

const appState = vi.hoisted(() => ({
  graph: { version: 2, nodes: [], emptySections: [], unplaced: [] } as unknown as Graph,
  setGraph: vi.fn(),
  selectedNodeId: undefined as string | undefined,
  debugMode: false,
  debugState: undefined,
  setBreakpoints: vi.fn(async () => {}),
}));
vi.mock('../../state/AppState', () => ({ useAppState: () => appState }));

import { Inspector } from '../Inspector';

const baseGraph = (): Graph =>
  specToGraph({
    version: 2,
    name: 'bot',
    model: 'mock/mock-1',
    instructions: 'p',
    abortListeners: [{ id: 'a1', triggerId: 't1', when: 'event.x', match: 'run.y', scope: 'both' }],
  } as unknown as Parameters<typeof specToGraph>[0]);

beforeEach(() => {
  appState.graph = baseGraph();
  appState.selectedNodeId = 'abort:a1';
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
    expect(container.querySelector('.inspector-head .k')?.textContent).toBe('Selected node (abort)');
    expect(container.querySelector('.inspector-head .v')?.textContent).toBe('a1');
    const textarea = container.querySelector('#node-json') as HTMLTextAreaElement;
    expect(JSON.parse(textarea.value)).toEqual({ id: 'a1', triggerId: 't1', when: 'event.x', match: 'run.y', scope: 'both' });
    expect(container.textContent).toContain('This node has no form yet.');
  });

  it('a valid JSON edit on blur calls setGraph and changes the node data', () => {
    const container = render(<Inspector />);
    editJson(container, '{ "type": "string" }');
    expect(appState.setGraph).toHaveBeenCalledTimes(1);
    const next = appState.setGraph.mock.calls[0][0](appState.graph) as Graph;
    const output = next.nodes.find((n) => n.id === 'abort:a1')!;
    expect((output.data as AbortNodeData).item).toEqual({ type: 'string' });
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
