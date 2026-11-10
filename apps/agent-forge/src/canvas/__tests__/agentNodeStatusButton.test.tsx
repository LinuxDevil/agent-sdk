import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { render } from '../../ui/__tests__/render';
import { NODE_TYPES, flowNodeType, type CanvasNodeData } from '../AgentNode';
import { specToGraph } from '../../graph/v2/specToGraph';
import type { AgentSpecV2 } from '../../graph/v2/specTypes';
import type { GraphNode } from '../../graph/v2/types';

const graph = specToGraph({
  version: 2,
  name: 'a',
  model: 'mock/mock-1',
  instructions: 'x',
  tools: [{ builtin: 'http' }],
} as unknown as AgentSpecV2);
const toolNode = graph.nodes.find((n) => n.kind === 'tool')!;

function renderCard(graphNode: GraphNode, extra: Partial<CanvasNodeData> = {}): HTMLElement {
  const Card = NODE_TYPES[flowNodeType(graphNode.kind)];
  const data: CanvasNodeData = { graphNode, ...extra };
  const props = { id: graphNode.id, type: flowNodeType(graphNode.kind), data, selected: false } as unknown as NodeProps;
  const container = render(
    <ReactFlowProvider>
      <Card {...props} />
    </ReactFlowProvider>
  );
  return container.querySelector('.rf-node') as HTMLElement;
}

describe('node status pill → spans sheet button', () => {
  it.each(['running', 'paused', 'done', 'error'] as const)('wraps the %s pill in a View spans button', (status) => {
    const card = renderCard(toolNode, { status, onViewSpans: vi.fn() });
    const button = card.querySelector<HTMLButtonElement>('button.node-status-button.nodrag');
    expect(button).not.toBeNull();
    expect(button!.getAttribute('aria-label')).toBe('View spans for http');
    // 'paused' reads "awaiting approval" (StatusPill's LABELS map).
    const label = status === 'paused' ? 'awaiting approval' : status;
    expect(button!.querySelector('.status-pill')?.textContent).toBe(label);
  });

  it('leaves the pill a plain span while the node is idle or has no opener', () => {
    for (const status of ['idle', undefined] as const) {
      const card = renderCard(toolNode, { status, onViewSpans: vi.fn() });
      expect(card.querySelector('button.node-status-button')).toBeNull();
      expect(card.querySelector('.status-pill')).not.toBeNull();
    }
    // A non-idle node without onViewSpans (e.g. a card rendered outside the
    // builder's data wiring) keeps the inert pill rather than a dead button.
    const inert = renderCard(toolNode, { status: 'done' });
    expect(inert.querySelector('button.node-status-button')).toBeNull();
    expect(inert.querySelector('.status-pill')).not.toBeNull();
  });

  it('calls onViewSpans with the node id and stops propagation', () => {
    const onViewSpans = vi.fn();
    const parentClick = vi.fn();
    const Card = NODE_TYPES[flowNodeType(toolNode.kind)];
    const data: CanvasNodeData = { graphNode: toolNode, status: 'done', onViewSpans };
    const props = { id: toolNode.id, type: flowNodeType(toolNode.kind), data, selected: false } as unknown as NodeProps;
    render(
      <ReactFlowProvider>
        {/* A React onClick parent: the button's stopPropagation keeps the
            canvas's selection handler (also React-side) from firing twice. */}
        <div onClick={parentClick}>
          <Card {...props} />
        </div>
      </ReactFlowProvider>
    );
    const button = document.querySelector<HTMLButtonElement>('button.node-status-button')!;
    act(() => button.click());
    expect(onViewSpans).toHaveBeenCalledTimes(1);
    expect(onViewSpans).toHaveBeenCalledWith(toolNode.id);
    expect(parentClick).not.toHaveBeenCalled();
  });
});
