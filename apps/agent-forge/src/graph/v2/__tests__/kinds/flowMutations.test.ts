import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { specToGraph } from '../../specToGraph';
import { reorderChild, setOptionCondition } from '../../kinds/flow';
import { patchFlowMeta, patchNode } from '../../mutations';
import type { AgentSpecV2 } from '../../specTypes';
import type { FlowNodeData, Graph, NodeOfKind } from '../../types';

function flowNode(graph: Graph, id: string): NodeOfKind<'flow'> {
  const node = graph.nodes.find((n) => n.id === id);
  if (node === undefined || node.kind !== 'flow') throw new Error(`no flow node '${id}'`);
  return node;
}

function flowData(graph: Graph, id: string): FlowNodeData {
  return flowNode(graph, id).data;
}

const SEQ_SPEC = parse(`
version: 2
name: a
model: mock/mock-1
instructions: x
flow:
  code: f
  name: F
  inputs:
    - { name: ticket, type: string }
  flow:
    type: sequence
    id: s1
    steps:
      - { type: end, id: s2, value: one }
      - { type: end, id: s3, value: two }
      - { type: end, id: s4, value: three }
`) as AgentSpecV2;

const ROUTER_SPEC = parse(`
version: 2
name: a
model: mock/mock-1
instructions: x
flow:
  code: f
  name: F
  flow:
    type: oneOf
    id: r1
    options:
      - condition: "a == 1"
        step: { type: end, id: s2, value: one }
      - step: { type: end, id: s3, value: two }
`) as AgentSpecV2;

const seqGraph = () => specToGraph(SEQ_SPEC);
const routerGraph = () => specToGraph(ROUTER_SPEC);
const seqIds = (g: Graph) => (flowData(g, 'flow:s1').children as { ids: string[] }).ids;
const routerOptions = (g: Graph) =>
  (flowData(g, 'flow:r1').children as { options: { id: string; condition?: string }[] }).options;

describe('patchNode on flow nodes', () => {
  it('merges the patch into data.step, leaving children alone', () => {
    const graph = seqGraph();
    const next = patchNode(graph, 'flow:s2', { value: 'four' });
    expect(flowData(next, 'flow:s2').step).toMatchObject({ type: 'end', id: 's2', value: 'four' });
    expect(flowData(next, 'flow:s1').children).toEqual(flowData(graph, 'flow:s1').children);
  });

  it('removes a key patched to undefined', () => {
    const next = patchNode(seqGraph(), 'flow:s2', { value: undefined });
    expect(flowData(next, 'flow:s2').step.value).toBeUndefined();
  });

  it('does not touch flowMeta', () => {
    const graph = seqGraph();
    const next = patchNode(graph, 'flow:s1', { name: 'nope' });
    expect(flowData(next, 'flow:s1').step.name).toBe('nope');
    expect(flowData(next, 'flow:s1').flowMeta).toEqual(flowData(graph, 'flow:s1').flowMeta);
  });
});

describe('patchFlowMeta', () => {
  it('merges into the root step flowMeta', () => {
    const next = patchFlowMeta(seqGraph(), 'flow:s1', { description: 'Triages' });
    expect(flowData(next, 'flow:s1').flowMeta).toMatchObject({
      code: 'f',
      name: 'F',
      description: 'Triages',
      inputs: [{ name: 'ticket', type: 'string' }],
    });
  });

  it('removes flowMeta when the merge leaves it empty', () => {
    const next = patchFlowMeta(seqGraph(), 'flow:s1', {
      code: undefined,
      name: undefined,
      description: undefined,
      inputs: undefined,
      agents: undefined,
    });
    expect(flowData(next, 'flow:s1').flowMeta).toBeUndefined();
  });

  it('is a no-op on non-root flow nodes (no flowMeta)', () => {
    const g = seqGraph();
    expect(patchFlowMeta(g, 'flow:s2', { code: 'x' })).toStrictEqual(g);
  });
});

describe('reorderChild', () => {
  it('moves a step down and up inside sequence steps', () => {
    expect(seqIds(reorderChild(seqGraph(), 'flow:s1', 'flow:s2', 1))).toEqual(['flow:s3', 'flow:s2', 'flow:s4']);
    expect(seqIds(reorderChild(seqGraph(), 'flow:s1', 'flow:s4', -1))).toEqual(['flow:s2', 'flow:s4', 'flow:s3']);
  });

  it('is a no-op at either end', () => {
    const g = seqGraph();
    expect(seqIds(reorderChild(g, 'flow:s1', 'flow:s2', -1))).toEqual(['flow:s2', 'flow:s3', 'flow:s4']);
    expect(seqIds(reorderChild(g, 'flow:s1', 'flow:s4', 1))).toEqual(['flow:s2', 'flow:s3', 'flow:s4']);
  });

  it('is a no-op for a child the parent does not reference', () => {
    const g = seqGraph();
    expect(reorderChild(g, 'flow:s1', 'flow:s9', 1)).toStrictEqual(g);
  });

  it('reorders router options, conditions moving with their option', () => {
    const after = reorderChild(routerGraph(), 'flow:r1', 'flow:s2', 1);
    expect(routerOptions(after).map((o) => o.id)).toEqual(['flow:s3', 'flow:s2']);
    expect(routerOptions(after).find((o) => o.id === 'flow:s2')?.condition).toBe('a == 1');
  });
});

describe('setOptionCondition', () => {
  it('sets a trimmed condition on the named option', () => {
    const next = setOptionCondition(routerGraph(), 'flow:r1', 'flow:s3', '  b == 2 ');
    expect(routerOptions(next).find((o) => o.id === 'flow:s3')?.condition).toBe('b == 2');
  });

  it('clears the condition on empty input', () => {
    const next = setOptionCondition(routerGraph(), 'flow:r1', 'flow:s2', '');
    expect(routerOptions(next).find((o) => o.id === 'flow:s2')?.condition).toBeUndefined();
  });

  it('is a no-op on non-router parents', () => {
    const g = seqGraph();
    expect(setOptionCondition(g, 'flow:s1', 'flow:s2', 'x')).toStrictEqual(g);
  });
});
