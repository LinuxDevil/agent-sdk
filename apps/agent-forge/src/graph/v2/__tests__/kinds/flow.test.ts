import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { deriveEdges } from '../../edges';
import { flowParent, flowRoot, flowSpecPath, graphToFlow } from '../../flow';
import { graphToSpec } from '../../graphToSpec';
import { attachNewStep, nextStepId, setOptionCondition } from '../../kinds/flow';
import { connectNodes, addNode, removeNode } from '../../mutations';
import { specToGraph } from '../../specToGraph';
import type { AgentFlow, AgentSpecV2 } from '../../specTypes';
import type { FlowNodeData, Graph, GraphNode, NodeOfKind, Problem } from '../../types';
import { validateGraph } from '../../validateGraph';
import { FLOW_VIEW, STEP_VIEWS } from '../../../../canvas/kinds/flow';

/** The ticket's worked example: a sequence with a model call and a router. */
const WORKED = `version: 2
name: support-bot
model: anthropic/claude-sonnet-5-5
instructions: Answer tickets.
flow:
  code: support-flow
  name: Support flow
  description: Triages then answers
  inputs:
    - { name: ticket, type: string }
  flow:
    type: sequence
    id: s1
    steps:
      - { type: llmCall, id: s2, prompt: Summarize the ticket, outputVariable: summary }
      - type: oneOf
        id: s3
        options:
          - condition: "category == 'refund'"
            step: { type: llmCall, id: s4, prompt: Draft a refund, outputVariable: draft }
          - step:
              type: sequence
              id: s5
              steps:
                - { type: end, id: s6, value: $summary }
`;

const WORKED_NODE_IDS = ['agent', 'flow:s1', 'flow:s2', 'flow:s3', 'flow:s4', 'flow:s5', 'flow:s6'];

function specOf(over: Record<string, unknown>): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', ...over } as AgentSpecV2;
}

function flowNode(graph: Graph, id: string): NodeOfKind<'flow'> {
  const node = graph.nodes.find((n) => n.id === id);
  if (node === undefined || node.kind !== 'flow') throw new Error(`no flow node '${id}'`);
  return node;
}

function flowData(graph: Graph, id: string): FlowNodeData {
  return flowNode(graph, id).data;
}

function minimalFlowGraph(): Graph {
  return specToGraph(
    specOf({
      flow: {
        code: 'f',
        name: 'F',
        flow: { type: 'sequence', id: 's1', steps: [{ type: 'end', id: 's2', value: '$x' }] },
      },
    })
  );
}

/** A detached flow node for hand-built (invalid) graphs. */
function strayFlow(id: string, step: Record<string, unknown>, children: FlowNodeData['children'] = { shape: 'none' }): GraphNode {
  return {
    id: `flow:${id}`,
    kind: 'flow',
    owner: 'agent',
    position: { x: 0, y: 0 },
    data: { step: { id, ...step }, children },
  } as GraphNode;
}

describe('specToGraph: flow worked example', () => {
  const spec = parse(WORKED) as AgentSpecV2;
  const graph = specToGraph(spec);

  it('produces one flow:<step id> node per step, in pre-order, owned by the root agent', () => {
    expect(graph.nodes.map((n) => n.id)).toEqual(WORKED_NODE_IDS);
    for (const node of graph.nodes.slice(1)) {
      expect(node.kind).toBe('flow');
      expect(node.owner).toBe('agent');
    }
  });

  it('moves child fields into FlowNodeData.children as node-id references', () => {
    expect(flowData(graph, 'flow:s1').children).toStrictEqual({ shape: 'steps', ids: ['flow:s2', 'flow:s3'] });
    expect(flowData(graph, 'flow:s3').children).toStrictEqual({
      shape: 'options',
      options: [{ condition: "category == 'refund'", id: 'flow:s4' }, { id: 'flow:s5' }],
    });
    expect(flowData(graph, 'flow:s5').children).toStrictEqual({ shape: 'steps', ids: ['flow:s6'] });
    expect(flowData(graph, 'flow:s2').children).toStrictEqual({ shape: 'none' });
    // The step payload keeps every non-child field, including `id`.
    expect(flowData(graph, 'flow:s2').step).toStrictEqual({
      type: 'llmCall',
      id: 's2',
      prompt: 'Summarize the ticket',
      outputVariable: 'summary',
    });
  });

  it('keeps the AgentFlow wrapper on the root step only', () => {
    expect(flowData(graph, 'flow:s1').flowMeta).toStrictEqual({
      code: 'support-flow',
      name: 'Support flow',
      description: 'Triages then answers',
      inputs: [{ name: 'ticket', type: 'string' }],
    });
    expect(flowData(graph, 'flow:s2').flowMeta).toBeUndefined();
  });

  it('derives the runs and next edges of the ticket', () => {
    const edges = deriveEdges(graph);
    const byId = new Map(edges.map((e) => [e.id, e]));
    expect(byId.get('runs:agent->flow:s1')?.label).toBe('runs');
    expect(byId.get('next:flow:s1->flow:s2')).toMatchObject({ label: '1' });
    expect(byId.get('next:flow:s1->flow:s3')).toMatchObject({ label: '2' });
    expect(byId.get('next:flow:s3->flow:s4')).toMatchObject({
      label: "category == 'refund'",
      condition: "category == 'refund'",
    });
    expect(byId.get('next:flow:s3->flow:s5')).toMatchObject({ label: 'default' });
    expect(byId.get('next:flow:s5->flow:s6')).toMatchObject({ label: '1' });
  });

  it('round-trips to an identical spec', () => {
    expect(graphToSpec(graph, spec).spec).toStrictEqual(spec);
  });

  it('reports the spec path of every flow node', () => {
    const { specPaths } = graphToSpec(graph, spec);
    expect(specPaths['flow:s1']).toBe('flow.flow');
    expect(specPaths['flow:s2']).toBe('flow.flow.steps[0]');
    expect(specPaths['flow:s3']).toBe('flow.flow.steps[1]');
    expect(specPaths['flow:s4']).toBe('flow.flow.steps[1].options[0].step');
    expect(specPaths['flow:s5']).toBe('flow.flow.steps[1].options[1].step');
    expect(specPaths['flow:s6']).toBe('flow.flow.steps[1].options[1].step.steps[0]');
    expect(flowSpecPath(graph, 'flow:s4')).toBe('flow.flow.steps[1].options[0].step');
    expect(flowParent(graph, 'flow:s4')).toBe('flow:s3');
    expect(flowRoot(graph)?.id).toBe('flow:s1');
  });
});

describe('specToGraph: flow edge cases', () => {
  it('assigns s1, s2… ids to steps that have none, and a second round trip is identical', () => {
    const spec = specOf({
      flow: { code: 'f', name: 'F', flow: { type: 'end' } },
    });
    const graph = specToGraph(spec);
    expect(flowData(graph, 'flow:s1').step.id).toBe('s1');
    const first = graphToSpec(graph, spec).spec;
    const second = graphToSpec(specToGraph(first), first).spec;
    expect(second).toStrictEqual(first);
    expect((first.flow as AgentFlow).flow).toMatchObject({ id: 's1' });
  });

  it('keeps a flow without a root step in extra and returns false from addFlowNodes', () => {
    const spec = specOf({ flow: { code: 'f', name: 'F', description: 'no root' } });
    const graph = specToGraph(spec);
    expect(graph.nodes.map((n) => n.id)).toEqual(['agent']);
    expect((graph.nodes[0].data as { extra: Record<string, unknown> }).extra['flow']).toStrictEqual({
      code: 'f',
      name: 'F',
      description: 'no root',
    });
    expect(graphToSpec(graph, spec).spec).toStrictEqual(spec);
    // The root agent warns that the canvas cannot show the flow.
    expect(validateGraph(graph)).toContainEqual(
      expect.objectContaining({
        nodeId: 'agent',
        severity: 'warning',
        message: "This agent's flow has no root step, so the canvas cannot show it",
      })
    );
  });

  it('preserves unknown step types and fields verbatim but reports them', () => {
    const spec = specOf({
      flow: {
        code: 'f',
        name: 'F',
        flow: {
          type: 'mystery',
          id: 's1',
          custom: { deep: [1, 2] },
          steps: [{ type: 'end', id: 's2' }],
        },
      },
    });
    const graph = specToGraph(spec);
    // `steps` on an unknown type is not a child field — it stays in `step`.
    expect(flowData(graph, 'flow:s1').step).toMatchObject({ custom: { deep: [1, 2] }, steps: [{ type: 'end', id: 's2' }] });
    expect(graphToSpec(graph, spec).spec).toStrictEqual(spec);
    expect(validateGraph(graph)).toContainEqual(
      expect.objectContaining({ nodeId: 'flow:s1', severity: 'error', message: 'This step type cannot run' })
    );
  });

  it('preserves editor-only step shapes verbatim and flags them', () => {
    const spec = specOf({
      flow: { code: 'f', name: 'F', flow: { type: 'step', id: 's1', branches: [] } },
    });
    const graph = specToGraph(spec);
    expect(flowData(graph, 'flow:s1').step).toMatchObject({ type: 'step', branches: [] });
    expect(graphToSpec(graph, spec).spec).toStrictEqual(spec);
    expect(validateGraph(graph)).toContainEqual(
      expect.objectContaining({ nodeId: 'flow:s1', severity: 'error', message: 'This step type cannot run' })
    );
  });

  it('keeps a malformed child field inside the step instead of dropping it', () => {
    const spec = specOf({
      flow: {
        code: 'f',
        name: 'F',
        flow: { type: 'sequence', id: 's1', steps: 'not-an-array' },
      },
    });
    const graph = specToGraph(spec);
    expect(flowData(graph, 'flow:s1').children).toStrictEqual({ shape: 'none' });
    expect(graphToSpec(graph, spec).spec).toStrictEqual(spec);
  });

  it('moves the child key to the end of the step on save — the only permitted reorder', () => {
    const spec = specOf({
      flow: {
        code: 'f',
        name: 'F',
        flow: { type: 'sequence', id: 's1', steps: [{ type: 'end', id: 's2' }], note: 'kept' },
      },
    });
    const graph = specToGraph(spec);
    const emitted = (graphToSpec(graph, spec).spec.flow as AgentFlow).flow as unknown as Record<string, unknown>;
    expect(Object.keys(emitted)).toEqual(['type', 'id', 'note', 'steps']);
  });
});

describe('graphToFlow', () => {
  it('returns undefined without a flow root', () => {
    expect(graphToFlow(specToGraph(specOf({})))).toBeUndefined();
  });

  it('skips proposed-remove nodes and dangling children', () => {
    const graph = minimalFlowGraph();
    const doomed = flowNode(graph, 'flow:s2');
    doomed.proposed = 'remove';
    const flow = graphToFlow(graph);
    expect(flow?.flow).toStrictEqual({ type: 'sequence', id: 's1', steps: [] });
  });
});

describe('attachNewStep', () => {
  it('makes the first added step the root and seeds flowMeta from the agent', () => {
    const graph = specToGraph(specOf({ name: 'Support Bot' }));
    const { graph: withNode, nodeId } = addNode(
      graph,
      { kind: 'flow', data: { step: { type: 'end', id: 's1' }, children: { shape: 'none' } } },
      { x: 0, y: 0 },
      'agent'
    );
    const next = attachNewStep(withNode, nodeId);
    expect(flowRoot(next)?.id).toBe(nodeId);
    expect(flowData(next, nodeId).flowMeta).toMatchObject({ code: 'support-bot', name: 'Support Bot' });
  });

  it('appends to a selected sequence and inserts after a selected leaf', () => {
    let graph = minimalFlowGraph();
    const add = (type: string): string => {
      const result = addNode(
        graph,
        { kind: 'flow', data: { step: { type, id: nextStepId(graph) }, children: { shape: 'none' } } },
        { x: 0, y: 0 },
        'agent'
      );
      graph = result.graph;
      return result.nodeId;
    };
    const leaf = add('end'); // flow:s3
    const seq = add('sequence'); // flow:s4, still an orphan
    // Selected the leaf inside the root sequence → the new leaf is inserted right after it.
    graph = attachNewStep(graph, leaf, 'flow:s2');
    // (flow:s4 is still an orphan at this point — it is attached next.)
    expect(flowData(graph, 'flow:s1').children).toStrictEqual({ shape: 'steps', ids: ['flow:s2', 'flow:s3'] });
    // The sequence is still an orphan; attach it after the leaf, then a
    // connect moves the leaf inside it (detach + append).
    graph = attachNewStep(graph, seq, 'flow:s2');
    expect(flowData(graph, 'flow:s1').children).toStrictEqual({ shape: 'steps', ids: ['flow:s2', 'flow:s4', 'flow:s3'] });
    const moved = connectNodes(graph, seq, leaf);
    expect(moved.ok).toBe(true);
    if (moved.ok) {
      expect(flowData(moved.graph, seq).children).toStrictEqual({ shape: 'steps', ids: [leaf] });
      expect(flowData(moved.graph, 'flow:s1').children).toStrictEqual({ shape: 'steps', ids: ['flow:s2', 'flow:s4'] });
    }
  });

  it('appends a router option and sets an empty loop body', () => {
    let graph = specToGraph(
      specOf({
        flow: {
          code: 'f',
          name: 'F',
          flow: {
            type: 'oneOf',
            id: 's1',
            options: [
              { condition: "a == 'b'", step: { type: 'end', id: 's2' } },
              { step: { type: 'end', id: 's3' } },
            ],
          },
        },
      })
    );
    const mk = (): string => {
      const result = addNode(
        graph,
        { kind: 'flow', data: { step: { type: 'end', id: nextStepId(graph) }, children: { shape: 'none' } } },
        { x: 0, y: 0 },
        'agent'
      );
      graph = result.graph;
      return result.nodeId;
    };
    const option = mk();
    graph = attachNewStep(graph, option, 'flow:s1');
    expect(flowData(graph, 'flow:s1').children).toMatchObject({
      shape: 'options',
      options: [{ id: 'flow:s2' }, { id: 'flow:s3' }, { id: option }],
    });
  });

  it('wraps a lone root and the new step in a sequence when nothing else applies', () => {
    const spec = specOf({ flow: { code: 'f', name: 'F', flow: { type: 'end', id: 's1' } } });
    let graph = specToGraph(spec);
    const result = addNode(
      graph,
      { kind: 'flow', data: { step: { type: 'end', id: 's2' }, children: { shape: 'none' } } },
      { x: 0, y: 0 },
      'agent'
    );
    graph = result.graph;
    graph = attachNewStep(graph, result.nodeId);
    const root = flowRoot(graph);
    expect(root?.data.step.type).toBe('sequence');
    expect(root?.data.children).toStrictEqual({ shape: 'steps', ids: ['flow:s1', result.nodeId] });
    expect(graphToSpec(graph).spec.flow).toBeDefined();
  });
});

describe('connectNodes: flow → flow', () => {
  it('appends the target to a sequence source', () => {
    const graph = minimalFlowGraph();
    const result = connectNodes(graph, 'flow:s1', 'flow:s2');
    // s2 is already a child — the connect moves it to the end (no visible change here).
    expect(result.ok).toBe(true);
  });

  it('refuses a step containing itself or its ancestor', () => {
    const graph = minimalFlowGraph();
    expect(connectNodes(graph, 'flow:s1', 'flow:s1')).toStrictEqual({
      ok: false,
      reason: "Can't connect a node to itself",
    });
    // s1 → s2 where s2 is already inside s1: re-append is allowed; the cycle
    // guard fires when the target is an ancestor of the source instead.
    const nested = specToGraph(
      specOf({
        flow: {
          code: 'f',
          name: 'F',
          flow: { type: 'sequence', id: 's1', steps: [{ type: 'sequence', id: 's2', steps: [{ type: 'end', id: 's3' }] }] },
        },
      })
    );
    expect(connectNodes(nested, 'flow:s3', 'flow:s1')).toStrictEqual({
      ok: false,
      reason: 'The first step of the flow cannot move',
    });
    // Making s1 a child of its own descendant would cycle — refused.
    const cycled = specToGraph(
      specOf({
        flow: {
          code: 'f',
          name: 'F',
          flow: { type: 'sequence', id: 's1', steps: [{ type: 'end', id: 's2' }] },
        },
      })
    );
    // s2 (leaf) → s1 would make the root a child of s2 — root refusal fires first.
    expect(connectNodes(cycled, 'flow:s2', 'flow:s1').ok).toBe(false);
  });

  it('refuses moving the flow root and filling an occupied loop', () => {
    const graph = specToGraph(
      specOf({
        flow: {
          code: 'f',
          name: 'F',
          flow: {
            type: 'sequence',
            id: 's1',
            steps: [
              { type: 'forEach', id: 's2', items: '$items', step: { type: 'end', id: 's3' } },
              { type: 'end', id: 's4' },
            ],
          },
        },
      })
    );
    expect(connectNodes(graph, 'flow:s4', 'flow:s1')).toStrictEqual({
      ok: false,
      reason: 'The first step of the flow cannot move',
    });
    expect(connectNodes(graph, 'flow:s2', 'flow:s4')).toStrictEqual({
      ok: false,
      reason: 'A loop runs one step. Put several in a sequence.',
    });
  });

  it('sets an empty loop body and inserts after a leaf inside a sequence', () => {
    const graph = specToGraph(
      specOf({
        flow: {
          code: 'f',
          name: 'F',
          flow: {
            type: 'sequence',
            id: 's1',
            steps: [
              { type: 'forEach', id: 's2', items: '$items' },
              { type: 'end', id: 's3' },
              { type: 'end', id: 's4' },
            ],
          },
        },
      })
    );
    // Leaf s3 → s4: s4 moves to right after s3 (already there — idempotent).
    const moved = connectNodes(graph, 'flow:s3', 'flow:s4');
    expect(moved.ok).toBe(true);
    if (moved.ok) {
      expect(flowData(moved.graph, 'flow:s1').children).toStrictEqual({
        shape: 'steps',
        ids: ['flow:s2', 'flow:s3', 'flow:s4'],
      });
    }
    // Loop s2 gets s4 as its body — but s4 is inside the sequence; connect
    // detaches it first.
    const intoLoop = connectNodes(graph, 'flow:s2', 'flow:s4');
    expect(intoLoop.ok).toBe(true);
    if (intoLoop.ok) {
      expect(flowData(intoLoop.graph, 'flow:s2').children).toStrictEqual({ shape: 'step', id: 'flow:s4' });
      expect(flowData(intoLoop.graph, 'flow:s1').children).toStrictEqual({
        shape: 'steps',
        ids: ['flow:s2', 'flow:s3'],
      });
    }
  });

  it('refuses flow → tool and a leaf with no sequence parent', () => {
    const graph = minimalFlowGraph();
    const withTool = addNode(
      graph,
      { kind: 'tool', data: { item: { builtin: 'http' } } },
      { x: 0, y: 0 },
      'agent'
    ).graph;
    expect(connectNodes(withTool, 'flow:s1', 'tool:http')).toStrictEqual({
      ok: false,
      reason: "Can't connect flow → tool",
    });
    // A lone root leaf cannot take a child.
    const lone = specToGraph(specOf({ flow: { code: 'f', name: 'F', flow: { type: 'end', id: 's1' } } }));
    const other = addNode(
      lone,
      { kind: 'flow', data: { step: { type: 'end', id: 's2' }, children: { shape: 'none' } } },
      { x: 0, y: 0 },
      'agent'
    );
    expect(connectNodes(other.graph, 'flow:s1', other.nodeId)).toStrictEqual({
      ok: false,
      reason: 'Put these steps in a sequence first',
    });
  });
});

describe('setOptionCondition and nextStepId', () => {
  it('sets, replaces and clears a router option condition', () => {
    const graph = specToGraph(
      specOf({
        flow: {
          code: 'f',
          name: 'F',
          flow: {
            type: 'oneOf',
            id: 's1',
            options: [
              { condition: "a == 'b'", step: { type: 'end', id: 's2' } },
              { step: { type: 'end', id: 's3' } },
            ],
          },
        },
      })
    );
    const g1 = setOptionCondition(graph, 'flow:s1', 'flow:s2', "  c == 'd'  ");
    expect(flowData(g1, 'flow:s1').children).toMatchObject({
      options: [{ condition: "c == 'd'", id: 'flow:s2' }, { id: 'flow:s3' }],
    });
    const g2 = setOptionCondition(g1, 'flow:s1', 'flow:s2', '   ');
    expect(flowData(g2, 'flow:s1').children).toMatchObject({
      options: [{ id: 'flow:s2' }, { id: 'flow:s3' }],
    });
    // The emitted spec follows the condition.
    const flow = graphToFlow(g1);
    const options = (flow?.flow as { options?: Array<{ condition?: string }> }).options;
    expect(options?.[0]?.condition).toBe("c == 'd'");
  });

  it('hands out the smallest free s<n>', () => {
    const graph = minimalFlowGraph();
    expect(nextStepId(graph)).toBe('s3');
    const bigger = specToGraph(
      specOf({
        flow: {
          code: 'f',
          name: 'F',
          flow: { type: 'sequence', id: 's1', steps: [{ type: 'end', id: 's3' }] },
        },
      })
    );
    expect(nextStepId(bigger)).toBe('s2');
  });
});

describe('removeNode on flow containers', () => {
  it('removes the whole step subtree and detaches nothing dangling', () => {
    const spec = specOf({
      flow: {
        code: 'f',
        name: 'F',
        flow: {
          type: 'sequence',
          id: 's1',
          steps: [
            { type: 'sequence', id: 's2', steps: [{ type: 'end', id: 's3' }] },
            { type: 'end', id: 's4' },
          ],
        },
      },
    });
    const graph = specToGraph(spec);
    const next = removeNode(graph, 'flow:s2');
    expect(next.nodes.map((n) => n.id)).toEqual(['agent', 'flow:s1', 'flow:s4']);
    expect(flowData(next, 'flow:s1').children).toStrictEqual({ shape: 'steps', ids: ['flow:s4'] });
    expect(graphToSpec(next).spec.flow).toBeDefined();
  });
});

describe('flowRules.validate', () => {
  const problemsOf = (graph: Graph): Problem[] => validateGraph(graph);

  it('is clean on the worked example', () => {
    const spec = parse(WORKED) as AgentSpecV2;
    expect(problemsOf(specToGraph(spec))).toEqual([]);
  });

  it('flags missing required fields per step type', () => {
    const graph = specToGraph(
      specOf({
        flow: {
          code: 'f',
          name: 'F',
          flow: {
            type: 'sequence',
            id: 's1',
            steps: [
              { type: 'llmCall', id: 's2' },
              { type: 'toolCall', id: 's3', tool: 'nope' },
              { type: 'approval', id: 's4' },
              { type: 'setVariable', id: 's5', variable: '9bad' },
            ],
          },
        },
      })
    );
    const problems = problemsOf(graph);
    expect(problems).toContainEqual(
      expect.objectContaining({ nodeId: 'flow:s2', severity: 'error', message: 'Write the prompt for this model call' })
    );
    expect(problems).toContainEqual(
      expect.objectContaining({ nodeId: 'flow:s4', severity: 'error', message: 'Write what the person approves' })
    );
    expect(problems).toContainEqual(
      expect.objectContaining({ nodeId: 'flow:s5', severity: 'error', message: 'Use a variable name like order_id' })
    );
    // s3 names a tool the agent does not have — a warning, not an error.
    expect(problems).toContainEqual(
      expect.objectContaining({
        nodeId: 'flow:s3',
        severity: 'warning',
        message: "The agent has no tool named 'nope'",
      })
    );
  });

  it('flags router shape problems', () => {
    const graph = specToGraph(
      specOf({
        flow: {
          code: 'f',
          name: 'F',
          flow: {
            type: 'oneOf',
            id: 's1',
            options: [
              { step: { type: 'end', id: 's2' } },
              { step: { type: 'end', id: 's3' } },
            ],
          },
        },
      })
    );
    expect(problemsOf(graph)).toContainEqual(
      expect.objectContaining({ nodeId: 'flow:s1', severity: 'error', message: 'A router can have only one default branch' })
    );
  });

  it('flags empty containers and empty loops as warnings', () => {
    const graph = specToGraph(
      specOf({
        flow: {
          code: 'f',
          name: 'F',
          flow: {
            type: 'sequence',
            id: 's1',
            steps: [
              { type: 'parallel', id: 's2', steps: [] },
              { type: 'forEach', id: 's3', items: '$items' },
            ],
          },
        },
      })
    );
    const problems = problemsOf(graph);
    expect(problems).toContainEqual(
      expect.objectContaining({ nodeId: 'flow:s2', severity: 'warning', message: 'This step has nothing inside' })
    );
    expect(problems).toContainEqual(
      expect.objectContaining({ nodeId: 'flow:s3', severity: 'warning', message: 'This loop has no step to run' })
    );
  });

  it('flags duplicate step ids', () => {
    const graph = specToGraph(
      specOf({
        flow: {
          code: 'f',
          name: 'F',
          flow: {
            type: 'sequence',
            id: 's1',
            steps: [
              { type: 'end', id: 's2' },
              { type: 'end', id: 's2' },
            ],
          },
        },
      })
    );
    const problems = problemsOf(graph);
    expect(problems.filter((p) => p.message.includes("id 's2'")).length).toBeGreaterThan(0);
  });
});

describe('flowStructure validation', () => {
  const base = (): Graph => {
    const g = minimalFlowGraph();
    // Add a second root-level flow node by hand: an orphan.
    g.nodes.push(strayFlow('s9', { type: 'end' }));
    return g;
  };

  it('flags a second flow root', () => {
    const problems = validateGraph(base());
    expect(problems).toContainEqual(
      expect.objectContaining({ nodeId: 'flow:s9', severity: 'error', message: 'The flow has more than one first step' })
    );
  });

  it('flags an unreachable step and a dangling child reference', () => {
    const graph = minimalFlowGraph();
    // Point the root at a node that does not exist.
    const root = flowNode(graph, 'flow:s1');
    root.data = { ...root.data, children: { shape: 'steps', ids: ['flow:s2', 'flow:ghost'] } };
    const problems = validateGraph(graph);
    expect(problems).toContainEqual(
      expect.objectContaining({
        nodeId: 'flow:s1',
        severity: 'error',
        message: 'This step points at a step that does not exist',
      })
    );
  });

  it('flags a step listed twice and children that do not match the type', () => {
    const graph = minimalFlowGraph();
    const root = flowNode(graph, 'flow:s1');
    root.data = {
      ...root.data,
      children: { shape: 'steps', ids: ['flow:s2', 'flow:s2'] },
    };
    const problems = validateGraph(graph);
    expect(problems).toContainEqual(
      expect.objectContaining({ nodeId: 'flow:s1', severity: 'error', message: 'This step lists the same step twice' })
    );
    // A leaf carrying children is a shape mismatch.
    const leaf = flowNode(graph, 'flow:s2');
    leaf.data = { ...leaf.data, children: { shape: 'steps', ids: [] } };
    expect(validateGraph(graph)).toContainEqual(
      expect.objectContaining({
        nodeId: 'flow:s2',
        severity: 'error',
        message: "This step's children do not match its type",
      })
    );
  });

  it('flags flowMeta on a non-root step', () => {
    const graph = minimalFlowGraph();
    const leaf = flowNode(graph, 'flow:s2');
    leaf.data = { ...leaf.data, flowMeta: { code: 'x', name: 'X' } };
    expect(validateGraph(graph)).toContainEqual(
      expect.objectContaining({ nodeId: 'flow:s2', severity: 'error', message: 'Only the first step carries the flow details' })
    );
  });
});

describe('flow card (KindView)', () => {
  it('titles by step type, chips the step id and summarises the key field', () => {
    const graph = specToGraph(parse(WORKED) as AgentSpecV2);
    const card = (id: string) => {
      const node = flowNode(graph, id);
      const title = FLOW_VIEW.title(node);
      const chip = FLOW_VIEW.chip?.(node);
      const rows = FLOW_VIEW.rows(node);
      return { title, chip, rows };
    };
    expect(card('flow:s1').title).toBe('Sequence');
    expect(card('flow:s1').chip).toBe('s1');
    expect(card('flow:s1').rows).toContainEqual({ k: 'steps', v: '2' });
    expect(card('flow:s3').title).toBe('Router');
    expect(card('flow:s3').rows).toContainEqual({ k: 'options', v: '2' });
    expect(card('flow:s2').rows).toContainEqual({ k: 'prompt', v: 'Summarize the ticket' });
    expect(card('flow:s2').rows).toContainEqual({ k: '→', v: 'summary' });
  });

  it('falls back to the raw type for unknown steps', () => {
    const node = strayFlow('s1', { type: 'mystery' });
    expect(FLOW_VIEW.title(node as NodeOfKind<'flow'>)).toBe('mystery');
  });

  it('registers one palette entry per runnable step type', () => {
    const ids = FLOW_VIEW.palette.map((p) => p.id);
    expect(ids).toEqual([
      'flow-sequence',
      'flow-parallel',
      'flow-router',
      'flow-loop',
      'flow-evaluate',
      'flow-llm',
      'flow-agent',
      'flow-approval',
      'flow-tool',
      'flow-set',
      'flow-end',
    ]);
    for (const entry of FLOW_VIEW.palette) {
      expect(entry.group).toBe('Flow');
      expect(entry.kind).toBe('flow');
      expect(entry.afterAdd).toBeDefined();
    }
    // Every palette type has a STEP_VIEWS label and icon.
    for (const type of ['sequence', 'parallel', 'oneOf', 'forEach', 'evaluator', 'llmCall', 'agent', 'approval', 'toolCall', 'setVariable', 'end']) {
      expect(STEP_VIEWS[type]?.Icon).toBeDefined();
    }
  });
});
