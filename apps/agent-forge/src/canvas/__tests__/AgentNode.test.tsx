import { describe, it, expect, vi } from 'vitest';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { render } from '../../ui/__tests__/render';
import { NODE_TYPES, flowNodeType, type AgentNodeData } from '../AgentNode';
import { specToGraph } from '../../graph/specToGraph';
import type { AgentGraphNode } from '../../graph/types';

const graph = specToGraph({
  name: 'support-bot',
  prompt: 'p',
  provider: { type: 'openai', model: 'gpt-4o-mini' },
  tools: ['http', 'search'],
});
const nodeOf = (type: AgentGraphNode['type']) => graph.nodes.find((n) => n.type === type)!;

function renderCard(graphNode: AgentGraphNode, extra: Partial<AgentNodeData> = {}): HTMLElement {
  const Card = NODE_TYPES[flowNodeType(graphNode.type)];
  const data: AgentNodeData = { graphNode, onRename: vi.fn(), ...extra };
  const props = { id: graphNode.id, type: flowNodeType(graphNode.type), data, selected: false } as unknown as NodeProps;
  const container = render(
    <ReactFlowProvider>
      <Card {...props} />
    </ReactFlowProvider>
  );
  return container.querySelector('.rf-node') as HTMLElement;
}

describe('AgentNode card', () => {
  it('shows the name, a provider/model chip, the tool count and the run status', () => {
    const card = renderCard(nodeOf('llm'), { toolCount: 2, status: 'running' });
    expect(card.querySelector('.rf-node-title')?.textContent).toBe('support-bot');
    expect(card.querySelector('.node-model')?.textContent).toBe('openai/gpt-4o-mini');
    expect(card.querySelector('.node-tools')?.textContent).toBe('2 tools');
    expect(card.querySelector('.status-pill')?.textContent).toBe('running');
  });

  it('is idle with no tool count when nothing is known', () => {
    const card = renderCard(nodeOf('llm'));
    expect(card.querySelector('.node-tools')).toBeNull();
    expect(card.querySelector('.status-pill')?.textContent).toBe('idle');
  });

  it('has no model chip on a non-LLM node', () => {
    const card = renderCard(nodeOf('tool'), { status: 'done' });
    expect(card.querySelector('.node-model')).toBeNull();
    expect(card.querySelector('.node-row code')?.textContent).toBe('http');
  });

  it('renders the LLM card markup', () => {
    const card = renderCard(nodeOf('llm'), { toolCount: 1, status: 'paused' });
    expect(card.outerHTML).toMatchSnapshot();
  });
});
