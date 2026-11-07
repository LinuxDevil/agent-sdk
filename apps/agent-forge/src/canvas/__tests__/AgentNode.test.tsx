import { describe, it, expect } from 'vitest';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { render } from '../../ui/__tests__/render';
import { NODE_TYPES, flowNodeType, type AgentNodeData } from '../AgentNode';
import { specToGraph } from '../../graph/v2/specToGraph';
import type { GraphNode } from '../../graph/v2/types';

const graph = specToGraph({
  version: 2,
  name: 'support-bot',
  model: 'openai/gpt-4o-mini',
  instructions: 'p',
  tools: [{ builtin: 'http' }],
});
const nodeOf = (kind: GraphNode['kind']) => graph.nodes.find((n) => n.kind === kind)!;

function renderCard(graphNode: GraphNode, extra: Partial<AgentNodeData> = {}): HTMLElement {
  const Card = NODE_TYPES[flowNodeType(graphNode.kind)];
  const data: AgentNodeData = { graphNode, ...extra };
  const props = { id: graphNode.id, type: flowNodeType(graphNode.kind), data, selected: false } as unknown as NodeProps;
  const container = render(
    <ReactFlowProvider>
      <Card {...props} />
    </ReactFlowProvider>
  );
  return container.querySelector('.rf-node') as HTMLElement;
}

describe('AgentNode card', () => {
  it('shows the generic title (the node id after the last colon), its kind and the run status', () => {
    const card = renderCard(nodeOf('agent'), { status: 'running' });
    expect(card.querySelector('.rf-node-title')?.textContent).toBe('agent');
    expect(card.getAttribute('data-node-kind')).toBe('agent');
    expect(card.getAttribute('data-node-id')).toBe('agent');
    expect(card.querySelector('.status-pill')?.textContent).toBe('running');
  });

  it('is idle by default and names a tool node by its spec name', () => {
    const card = renderCard(nodeOf('tool'));
    expect(card.querySelector('.rf-node-title')?.textContent).toBe('http');
    expect(card.getAttribute('data-node-kind')).toBe('tool');
    expect(card.querySelector('.status-pill')?.textContent).toBe('idle');
  });

  it('draws both ports and the neutral kind tile of the generic view', () => {
    const card = renderCard(nodeOf('tool'), { status: 'done' });
    expect(card.querySelector('.rf-port-in')).not.toBeNull();
    expect(card.querySelector('.rf-port-out')).not.toBeNull();
    expect(card.querySelector('.node-kind')?.classList.contains('kind-neutral')).toBe(true);
    expect(card.querySelector('.node-kind svg')).not.toBeNull();
    expect(card.classList.contains('running')).toBe(false);
  });

  it('keeps running, selected, highlighted and breakpoint states together on one card', () => {
    const Card = NODE_TYPES[flowNodeType('agent')];
    const data: AgentNodeData = { graphNode: nodeOf('agent'), status: 'running', hasBreakpoint: true, highlighted: true };
    const props = { id: 'agent', type: flowNodeType('agent'), data, selected: true } as unknown as NodeProps;
    const container = render(
      <ReactFlowProvider>
        <Card {...props} />
      </ReactFlowProvider>
    );
    const card = container.querySelector('.rf-node') as HTMLElement;
    for (const state of ['running', 'selected', 'highlighted', 'has-breakpoint']) expect(card.classList).toContain(state);
  });

  it('renders the generic card markup', () => {
    const card = renderCard(nodeOf('tool'), { status: 'paused' });
    expect(card.outerHTML).toMatchSnapshot();
  });
});
