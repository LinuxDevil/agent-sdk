import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { deriveEdges } from '../../edges';
import { graphToSpec } from '../../graphToSpec';
import { duplicateNode } from '../../mutations';
import { specToGraph } from '../../specToGraph';
import type { AgentSpecV2, MemorySpec } from '../../specTypes';
import type { Graph, MemoryNodeData, Problem } from '../../types';
import { validateGraph } from '../../validateGraph';

/** The ticket's worked example: a scoped vector slot plus a session scratch pad. */
const WORKED = `version: 2
name: support-bot
model: anthropic/claude-sonnet-5-5
instructions: Answer tickets.
memory:
  - name: customers
    description: Facts about each customer
    scope:
      metadataKey: userId
    provider:
      type: sqlite-vector
      path: .lousho/memory.db
      embedder: openai/text-embedding-3-small
      minScore: 0.3
    recall:
      query: last-input
      maxItems: 5
    expose:
      remember: true
      recall: true
  - name: scratch
    scope: session
    provider:
      type: in-memory
`;

const WORKED_IDS = ['agent', 'memory:customers', 'memory:scratch'];

function specOf(over: Record<string, unknown>): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', ...over } as AgentSpecV2;
}

function graphOf(memory: MemorySpec[]): ReturnType<typeof specToGraph> {
  return specToGraph(specOf({ memory }));
}

function nodeById(graph: Graph, id: string): MemoryNodeData {
  const node = graph.nodes.find((n) => n.id === id);
  if (node === undefined) throw new Error(`no node '${id}'`);
  return node.data as MemoryNodeData;
}

function problem(nodeId: string, severity: 'error' | 'warning', message: string, fieldPath: string): Problem {
  return { nodeId, severity, message, fieldPath };
}

function error(nodeId: string, message: string, fieldPath: string): Problem {
  return problem(nodeId, 'error', message, fieldPath);
}

function warning(nodeId: string, message: string, fieldPath: string): Problem {
  return problem(nodeId, 'warning', message, fieldPath);
}

/** A valid entry the cases below break one field at a time. */
const BASE: MemorySpec = { name: 'notes', scope: 'session', provider: { type: 'in-memory' } };

describe('specToGraph: memory worked example', () => {
  const graph = specToGraph(parse(WORKED) as AgentSpecV2);

  it('produces the two memory nodes with the listed ids, in order', () => {
    expect(graph.nodes.map((n) => n.id)).toEqual(WORKED_IDS);
  });

  it('keeps each spec entry verbatim as data.item, owned by the root agent', () => {
    const spec = parse(WORKED) as AgentSpecV2;
    const memory = spec.memory ?? [];
    for (const [i, node] of graph.nodes.slice(1).entries()) {
      expect(node.owner).toBe('agent');
      expect(node.kind).toBe('memory');
      expect((node.data as { item: unknown }).item).toStrictEqual(memory[i]);
    }
  });

  it('derives a uses edge from the agent to every memory slot', () => {
    const ids = deriveEdges(graph).map((e) => e.id);
    for (const id of WORKED_IDS.slice(1)) {
      expect(ids).toContain(`uses:agent->${id}`);
    }
  });

  it('round-trips to an identical spec', () => {
    const spec = parse(WORKED) as AgentSpecV2;
    expect(graphToSpec(specToGraph(spec)).spec).toStrictEqual(spec);
  });
});

describe('memoryRules.validate', () => {
  it('accepts the worked example', () => {
    expect(validateGraph(specToGraph(parse(WORKED) as AgentSpecV2), { schema: false })).toStrictEqual([]);
  });

  it.each(['', '  ', 'has space', 'dot.name', 'x'.repeat(56)])(
    'rejects the slot name %j',
    (name) => {
      const graph = graphOf([{ ...BASE, name }]);
      const nodeId = name === '' ? 'memory:new' : `memory:${name}`;
      expect(validateGraph(graph, { schema: false })).toStrictEqual([
        error(nodeId, 'The memory name can use letters, digits, dash or underscore', 'memory[0].name'),
      ]);
    },
  );

  it('rejects an empty metadata key', () => {
    const graph = graphOf([{ ...BASE, scope: { metadataKey: '' } }]);
    expect(validateGraph(graph, { schema: false })).toStrictEqual([
      error('memory:notes', 'Enter the metadata key', 'memory[0].scope.metadataKey'),
    ]);
  });

  it('rejects a file provider with an empty folder', () => {
    const graph = graphOf([{ ...BASE, provider: { type: 'file', dir: '' } }]);
    expect(validateGraph(graph, { schema: false })).toStrictEqual([
      error('memory:notes', 'Enter the folder for memory files', 'memory[0].provider.dir'),
    ]);
  });

  it('rejects a sqlite-vector provider without an embedder', () => {
    const graph = graphOf([{ ...BASE, provider: { type: 'sqlite-vector', embedder: '' } }]);
    expect(validateGraph(graph, { schema: false })).toStrictEqual([
      error('memory:notes', 'Pick an embedding model', 'memory[0].provider.embedder'),
    ]);
  });

  it('warns on an item key without an item schema', () => {
    const graph = graphOf([{ ...BASE, itemKey: 'customerId' }]);
    expect(validateGraph(graph, { schema: false })).toStrictEqual([
      warning('memory:notes', 'An item key needs an item schema', 'memory[0].itemKey'),
    ]);
  });

  it('warns on a global in-memory slot', () => {
    const graph = graphOf([{ ...BASE, scope: 'global' }]);
    expect(validateGraph(graph, { schema: false })).toStrictEqual([
      warning('memory:notes', 'In-memory items are lost when Studio restarts', 'memory[0].provider'),
    ]);
  });

  it('does not warn on a global file slot', () => {
    const graph = graphOf([{ ...BASE, scope: 'global', provider: { type: 'file', dir: 'memory' } }]);
    expect(validateGraph(graph, { schema: false })).toStrictEqual([]);
  });

  it('reports the name error before the warnings of one entry', () => {
    const graph = graphOf([{ name: 'bad name', scope: 'global', provider: { type: 'in-memory' }, itemKey: 'k' }]);
    expect(validateGraph(graph, { schema: false })).toStrictEqual([
      error('memory:bad name', 'The memory name can use letters, digits, dash or underscore', 'memory[0].name'),
      warning('memory:bad name', 'An item key needs an item schema', 'memory[0].itemKey'),
      warning('memory:bad name', 'In-memory items are lost when Studio restarts', 'memory[0].provider'),
    ]);
  });

  it('maps problems to the nested spec path inside an inline agent', () => {
    const graph = specToGraph(
      specOf({
        subagents: {
          a: {
            inline: {
              name: 'a',
              description: 'd',
              model: 'mock/mock-1',
              instructions: 'x',
              memory: [{ name: '', scope: 'session', provider: { type: 'in-memory' } }],
            },
          },
        },
      }),
    );
    expect(validateGraph(graph, { schema: false })).toStrictEqual([
      error('sub:a/memory:new', 'The memory name can use letters, digits, dash or underscore', 'subagents.a.inline.memory[0].name'),
    ]);
  });
});

describe('memoryRules.duplicateData', () => {
  it('gives a copy a fresh <name>-copy slot name', () => {
    const g = graphOf([{ name: 'notes', scope: 'global', provider: { type: 'in-memory' } }]);
    const first = duplicateNode(g, 'memory:notes');
    expect(first.nodeId).toBe('memory:notes-copy');
    expect(nodeById(first.graph, 'memory:notes-copy').item).toStrictEqual({
      name: 'notes-copy',
      scope: 'global',
      provider: { type: 'in-memory' },
    });
    const second = duplicateNode(first.graph, 'memory:notes');
    expect(second.nodeId).toBe('memory:notes-copy-2');
    expect(nodeById(second.graph, 'memory:notes-copy-2').item.name).toBe('notes-copy-2');
  });
});
