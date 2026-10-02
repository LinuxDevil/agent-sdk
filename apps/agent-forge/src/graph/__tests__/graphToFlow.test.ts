import { describe, expect, it } from 'vitest';
import { FlowExecutor, MockLLMProvider, type AgentConfig } from '@lousho/build-ai-agent';
import { graphToFlow, hasRouterNode } from '../graphToFlow';
import { graphToSpec } from '../graphToSpec';
import type { AgentGraphSpec } from '../types';

/**
 * A branching graph: llm(classify) -> router -> [tool(refund-tool) when
 * {{classify}} === 'refund', else straight to output]. Mirrors the shape
 * the canvas produces: llm feeds a router, each branch either continues
 * through a tool step or goes straight to output.
 */
function branchingGraph(): AgentGraphSpec {
  return {
    version: 1,
    nodes: [
      {
        id: 'trigger-1',
        type: 'trigger',
        position: { x: 0, y: 0 },
        label: 'Trigger',
        data: { trigger: { type: 'input' } },
      },
      {
        id: 'llm-1',
        type: 'llm',
        position: { x: 200, y: 0 },
        label: 'classify',
        data: { name: 'classify', prompt: 'Classify: {{input}}', provider: { type: 'mock', model: 'mock-1' } },
      },
      {
        id: 'router-1',
        type: 'router',
        position: { x: 400, y: 0 },
        label: 'Router',
        data: {},
      },
      {
        id: 'tool-1',
        type: 'tool',
        position: { x: 600, y: -60 },
        label: 'refund-tool',
        data: { toolName: 'refund-tool' },
      },
      {
        id: 'output-1',
        type: 'output',
        position: { x: 800, y: -60 },
        label: 'Output',
        data: {},
      },
      {
        id: 'output-2',
        type: 'output',
        position: { x: 600, y: 60 },
        label: 'Output (default)',
        data: {},
      },
    ],
    edges: [
      { id: 'e-trigger-llm', source: 'trigger-1', target: 'llm-1' },
      { id: 'e-llm-router', source: 'llm-1', target: 'router-1' },
      { id: 'e-router-tool', source: 'router-1', target: 'tool-1', condition: "'{{classify}}' === 'refund'" },
      { id: 'e-tool-output', source: 'tool-1', target: 'output-1' },
      { id: 'e-router-default', source: 'router-1', target: 'output-2' },
    ],
  };
}

describe('hasRouterNode', () => {
  it('is false for a plain fixed-pipeline graph', () => {
    const graph: AgentGraphSpec = {
      version: 1,
      nodes: [
        { id: 'l', type: 'llm', position: { x: 0, y: 0 }, label: 'l', data: { name: 'a', prompt: 'p', provider: { type: 'mock', model: 'mock-1' } } },
      ],
      edges: [],
    };
    expect(hasRouterNode(graph)).toBe(false);
  });

  it('is true once a router node exists', () => {
    expect(hasRouterNode(branchingGraph())).toBe(true);
  });
});

describe('graphToFlow', () => {
  it('throws if the graph has no llm node', () => {
    expect(() => graphToFlow({ version: 1, nodes: [], edges: [] }, 'x')).toThrow(/no llm node/);
  });

  it('compiles a router into a oneOf step with conditioned branches ordered before the default', () => {
    const flow = graphToFlow(branchingGraph(), 'triage');
    expect(flow.name).toBe('classify');
    expect(flow.code).toBe('triage');

    // root = sequence [llmCall, oneOf]
    const root = flow.flow as unknown as { type: string; steps: unknown[] };
    expect(root.type).toBe('sequence');
    const [llmStep, oneOfStep] = root.steps as [
      { type: string; outputVariable: string },
      { type: string; options: { condition?: string; step: { type: string } }[] },
    ];
    expect(llmStep.type).toBe('llmCall');
    expect(llmStep.outputVariable).toBe('classify');
    expect(oneOfStep.type).toBe('oneOf');
    expect(oneOfStep.options).toHaveLength(2);
    // Conditioned branch first, default branch last, regardless of edge array order.
    expect(oneOfStep.options[0].condition).toBe("'{{classify}}' === 'refund'");
    expect(oneOfStep.options[1].condition).toBeUndefined();
  });

  it('throws for an approval node reachable from a router', () => {
    const graph = branchingGraph();
    graph.nodes.push({
      id: 'approval-1',
      type: 'approval',
      position: { x: 600, y: 0 },
      label: 'Approval',
      data: { policy: { requiresApproval: true } },
    });
    // Route the default branch into the approval node instead of straight to output.
    graph.edges = graph.edges.filter((e) => e.id !== 'e-router-default');
    graph.edges.push({ id: 'e-router-approval', source: 'router-1', target: 'approval-1' });
    expect(() => graphToFlow(graph, 'x')).toThrow(/approval node/);
  });

  it('throws when a router has fewer than 2 branches', () => {
    const graph = branchingGraph();
    graph.edges = graph.edges.filter((e) => e.id !== 'e-router-default');
    expect(() => graphToFlow(graph, 'x')).toThrow(/at least 2 branches/);
  });

  it('throws when a non-router node has more than one outgoing edge', () => {
    const graph = branchingGraph();
    graph.edges.push({ id: 'e-extra', source: 'llm-1', target: 'output-2' });
    expect(() => graphToFlow(graph, 'x')).toThrow(/multiple outgoing edges|outgoing edges - only a router/);
  });
});

describe('graphToSpec embeds a compiled flow only when the graph branches', () => {
  it('adds spec.policy.flow for a router graph', () => {
    const spec = graphToSpec(branchingGraph());
    expect((spec.policy as { flow?: unknown })?.flow).toBeDefined();
  });

  it('leaves spec.policy untouched for a non-branching graph (non-regression)', () => {
    const graph: AgentGraphSpec = {
      version: 1,
      nodes: [
        {
          id: 'l',
          type: 'llm',
          position: { x: 0, y: 0 },
          label: 'l',
          data: { name: 'a', prompt: 'p', provider: { type: 'mock', model: 'mock-1' } },
        },
      ],
      edges: [],
    };
    const spec = graphToSpec(graph);
    expect(spec.policy).toBeUndefined();
  });
});

describe('a branching graph actually executes different paths via FlowExecutor at runtime', () => {
  const agent: AgentConfig = {
    id: 'branch-agent',
    name: 'Branch Agent',
    prompt: 'You are a routing test agent.',
    settings: { model: 'mock-1' },
  };

  function toolRegistryWithRefundTool() {
    // Minimal duck-typed ToolRegistry - only `.get()` is used by FlowExecutor.executeToolCall().
    return {
      get: (name: string) =>
        name === 'refund-tool'
          ? { tool: { description: 'x', parameters: {}, execute: async () => ({ refunded: true }) } }
          : undefined,
    } as unknown as import('@lousho/build-ai-agent').ToolRegistry;
  }

  it('takes the conditioned branch (runs the tool) when the LLM output matches its condition', async () => {
    const flow = graphToFlow(branchingGraph(), 'triage');
    const provider = new MockLLMProvider({ name: 'mock', responses: ['refund'] });
    const result = await FlowExecutor.execute(flow, {
      agent,
      provider,
      toolRegistry: toolRegistryWithRefundTool(),
      variables: {},
    });
    expect(result.success).toBe(true);
    expect(result.output).toEqual({ refunded: true });
  });

  it('takes the default branch (skips the tool, straight to output) when the condition does not match', async () => {
    const flow = graphToFlow(branchingGraph(), 'triage');
    const provider = new MockLLMProvider({ name: 'mock', responses: ['not-a-refund'] });
    const result = await FlowExecutor.execute(flow, {
      agent,
      provider,
      toolRegistry: toolRegistryWithRefundTool(),
      variables: {},
    });
    expect(result.success).toBe(true);
    // Output node with no prior tool step on this path resolves to `$classify`.
    expect(result.output).toBe('not-a-refund');
  });
});
