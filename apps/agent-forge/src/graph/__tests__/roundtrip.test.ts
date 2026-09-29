import { describe, expect, it } from 'vitest';
import type { AgentSpec } from '@loushy/build-ai-agent';
import { graphToSpec } from '../graphToSpec';
import { specToGraph } from '../specToGraph';
import type { AgentGraphSpec } from '../types';

const fullSpec: AgentSpec = {
  name: 'support-triage',
  prompt: 'You triage inbound support tickets.',
  provider: { type: 'openai', model: 'gpt-4o-mini' },
  tools: ['http', 'current-date'],
  policy: { requiresApproval: true, guardrails: ['no-pii'], customField: 'kept' },
  triggers: [{ type: 'webhook', channel: 'zendesk' }],
};

const minimalSpec: AgentSpec = {
  name: 'minimal-agent',
  prompt: 'Do the thing.',
  provider: { type: 'mock', model: 'mock-1' },
};

describe('spec -> graph -> spec round trip', () => {
  it('is lossless for a full spec (name/prompt/provider/tools/policy/triggers)', () => {
    const graph = specToGraph(fullSpec);
    const roundTripped = graphToSpec(graph);
    expect(roundTripped).toEqual(fullSpec);
  });

  it('is lossless for a minimal spec with no tools/policy/triggers', () => {
    const graph = specToGraph(minimalSpec);
    const roundTripped = graphToSpec(graph);
    expect(roundTripped).toEqual(minimalSpec);
  });

  it('always produces exactly one output node with no data, regardless of spec shape', () => {
    const graph = specToGraph(fullSpec);
    const outputNodes = graph.nodes.filter((n) => n.type === 'output');
    expect(outputNodes).toHaveLength(1);
    expect(outputNodes[0].data).toEqual({});
  });

  it('drops canvas position data (documented lossy field)', () => {
    const graph = specToGraph(fullSpec);
    // Move a node - graphToSpec has no field to carry position through, so
    // this has zero effect on the resulting spec.
    graph.nodes[0].position = { x: 999, y: 999 };
    expect(graphToSpec(graph)).toEqual(fullSpec);
  });
});

describe('graph -> spec -> graph round trip', () => {
  it('is lossless for node data on a graph built via specToGraph (canonical edges + fresh layout)', () => {
    const graph = specToGraph(fullSpec);
    const spec = graphToSpec(graph);
    const rebuiltGraph = specToGraph(spec);

    // Node ids are synthetic/regenerated, positions are freshly computed,
    // and edges are regenerated for the canonical pipeline shape - so we
    // compare node *data* (order-independent by type) rather than the
    // whole structure verbatim.
    const dataByType = (g: AgentGraphSpec) =>
      g.nodes.reduce<Record<string, unknown[]>>((acc, n) => {
        (acc[n.type] ??= []).push(n.data);
        return acc;
      }, {});

    expect(dataByType(rebuiltGraph)).toEqual(dataByType(graph));
    expect(rebuiltGraph.nodes).toHaveLength(graph.nodes.length);
    expect(rebuiltGraph.edges).toHaveLength(graph.edges.length);
  });

  describe('hooks (LOU-Q3)', () => {
    it('serializes enabled hooks into spec.policy.hooks, keyed by node, and drops disabled ones', () => {
      const graph = specToGraph(minimalSpec);
      const llmNode = graph.nodes.find((n) => n.type === 'llm')!;
      llmNode.hooks = [
        { id: 'h1', templateId: 'inject-context', name: 'inject-context', phase: 'pre', point: 'generate', enabled: true, code: 'return ctx;' },
        { id: 'h2', templateId: 'custom', name: 'disabled-one', phase: 'post', point: 'generate', enabled: false, code: 'return ctx;' },
      ];

      const spec = graphToSpec(graph);
      expect(spec.policy?.hooks).toEqual([
        { nodeKey: 'llm', id: 'h1', name: 'inject-context', phase: 'pre', point: 'generate', code: 'return ctx;' },
      ]);
    });

    it('re-attaches hooks from spec.policy.hooks back onto the matching node on load', () => {
      const specWithHooks: AgentSpec = {
        ...minimalSpec,
        policy: {
          hooks: [
            { nodeKey: 'llm', id: 'h1', name: 'inject-context', phase: 'pre', point: 'generate', code: 'return ctx;' },
          ],
        },
      };

      const graph = specToGraph(specWithHooks);
      const llmNode = graph.nodes.find((n) => n.type === 'llm')!;
      expect(llmNode.hooks).toEqual([
        { id: 'h1', templateId: 'custom', name: 'inject-context', phase: 'pre', point: 'generate', enabled: true, code: 'return ctx;' },
      ]);
    });

    it('round-trips hooks through graph -> spec -> graph -> spec losslessly', () => {
      const graph = specToGraph(minimalSpec);
      const toolNode = graph.nodes.find((n) => n.type === 'tool');
      const llmNode = graph.nodes.find((n) => n.type === 'llm')!;
      llmNode.hooks = [
        { id: 'h1', templateId: 'inject-context', name: 'inject-context', phase: 'pre', point: 'generate', enabled: true, code: 'return ctx;' },
      ];
      void toolNode;

      const spec1 = graphToSpec(graph);
      const graph2 = specToGraph(spec1);
      const spec2 = graphToSpec(graph2);

      expect(spec2).toEqual(spec1);
    });

    it('ignores spec.policy.hooks that are not shaped like SerializedHook[] rather than throwing', () => {
      const specWithBadHooks: AgentSpec = { ...minimalSpec, policy: { hooks: 'not-an-array' } };
      expect(() => specToGraph(specWithBadHooks)).not.toThrow();
      const graph = specToGraph(specWithBadHooks);
      expect(graph.nodes.every((n) => !n.hooks)).toBe(true);
    });
  });
});
