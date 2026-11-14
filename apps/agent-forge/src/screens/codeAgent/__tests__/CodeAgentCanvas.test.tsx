import { act } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
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

// The group collapse toggle and a few kind Fields read the app state; the
// code-agent canvas shows none of its writes, so a bare stub suffices.
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
    setGraph: vi.fn(),
    proposal: undefined,
  }),
}));

import type { AgentSpecV2 } from 'lousho';
import { specToGraph } from '../../../graph/v2/specToGraph';
import type { Graph } from '../../../graph/v2/types';
import { CodeAgentCanvas, CodeAgentInspector } from '../CodeAgentCanvas';
import { render } from '../../../ui/__tests__/render';

const SPEC = {
  version: 2,
  name: 'support-triage',
  model: 'mock/mock-1',
  instructions: 'Triage tickets.',
  tools: [{ builtin: 'http' }],
  subagents: {
    research: {
      inline: { name: 'research', description: 'Looks things up', model: 'mock/mock-1', instructions: 'Research.', tools: [{ builtin: 'web_fetch' }] },
    },
  },
} as unknown as AgentSpecV2;

function graphOf(spec: AgentSpecV2 = SPEC): Graph {
  return specToGraph(spec);
}

function mountCanvas(graph: Graph) {
  return render(
    <ReactFlowProvider>
      <CodeAgentCanvas graph={graph} agentKey="agents/support" />
    </ReactFlowProvider>
  );
}

describe('CodeAgentCanvas', () => {
  it('renders the spec nodes with only the Fit view toolbar action', () => {
    const host = mountCanvas(graphOf());
    // Root agent + its tool + the inline subagent group + the group's tool.
    expect(host.querySelectorAll('.rf-node, .rf-group').length).toBeGreaterThanOrEqual(4);
    const labels = [...host.querySelectorAll('.canvas-toolbar button')].map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(['Fit view']);
  });

  it('disables the group collapse toggle (it would write through AppState)', () => {
    const host = mountCanvas(graphOf());
    const toggle = host.querySelector<HTMLButtonElement>('.rf-group-toggle');
    expect(toggle).not.toBeNull();
    expect(toggle!.disabled).toBe(true);
    expect(toggle!.title).toBe('This canvas is read-only');
  });

  it('selecting a node shows its fields in a disabled fieldset', async () => {
    const host = mountCanvas(graphOf());
    const node = host.querySelector<HTMLElement>('.rf-node[data-node-id="agent"]');
    expect(node).not.toBeNull();
    await act(async () => {
      node!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const fieldset = host.querySelector<HTMLFieldSetElement>('.inspector fieldset[disabled]');
    expect(fieldset).not.toBeNull();
    expect(host.querySelector('.inspector .inspector-head')?.textContent).toContain('Agent');
  });
});

describe('CodeAgentInspector', () => {
  it('renders the node kind head and disabled fields', () => {
    const graph = graphOf();
    const tool = graph.nodes.find((n) => n.kind === 'tool')!;
    const host = render(<CodeAgentInspector graph={graph} node={tool} />);
    expect(host.querySelector('.inspector-head')?.textContent).toContain('Tool');
    const fieldset = host.querySelector<HTMLFieldSetElement>('fieldset');
    expect(fieldset?.disabled).toBe(true);
    // Every form control inside is disabled by the fieldset.
    const input = host.querySelector('input, select, textarea');
    expect(input).not.toBeNull();
  });
});
