import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import type { CanvasLayout } from '../../../../../shared/wireTypes';
import { deriveEdges } from '../../edges';
import { graphToSpec } from '../../graphToSpec';
import { connectNodes, duplicateNode } from '../../mutations';
import { specToGraph } from '../../specToGraph';
import type { AgentSpecV2 } from '../../specTypes';
import type { Graph, HookNodeData, NoteNodeData, Problem } from '../../types';
import { validateGraph } from '../../validateGraph';

/** The ticket's worked example: one file hook, one disabled inline hook, plus a canvas note above the agent. */
const WORKED = `version: 2
name: support-bot
model: anthropic/claude-sonnet-5-5
instructions: Answer tickets.
hooks:
  - { id: h1, file: hooks/loop-guard.ts }
  - id: h2
    inline:
      name: redact-pii
      point: preToolCall
      enabled: false
      code: "for (const k of Object.keys(ctx.args || {})) { /* redact */ } return ctx;"
`;

const WORKED_LAYOUT: CanvasLayout = {
  schemaVersion: 1,
  nodes: {},
  notes: [{ id: 'n1', x: 0, y: -160, text: 'Ask legal before enabling redact-pii' }],
};

function specOf(over: Record<string, unknown>): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', ...over } as AgentSpecV2;
}

function graphOf(hooks: Record<string, unknown>[], over: Record<string, unknown> = {}): Graph {
  return specToGraph(specOf({ hooks, ...over }));
}

function error(nodeId: string, message: string, fieldPath: string): Problem {
  return { nodeId, severity: 'error', message, fieldPath };
}

const item = (graph: Graph, id: string) =>
  (graph.nodes.find((n) => n.id === id)!.data as HookNodeData).item;

describe('specToGraph: hook worked example', () => {
  const spec = parse(WORKED) as AgentSpecV2;
  const graph = specToGraph(spec, WORKED_LAYOUT);

  it('produces the two hook nodes with hook:<id> ids, owned by the root agent', () => {
    const hooks = graph.nodes.filter((n) => n.kind === 'hook');
    expect(hooks.map((n) => n.id)).toEqual(['hook:h1', 'hook:h2']);
    for (const [i, node] of hooks.entries()) {
      expect(node.owner).toBe('agent');
      expect((node.data as HookNodeData).item).toStrictEqual((spec.hooks ?? [])[i]);
    }
  });

  it('keeps enabled: false on the inline item', () => {
    const h2 = item(graph, 'hook:h2');
    expect('inline' in h2 && h2.inline.enabled).toBe(false);
  });

  it('draws the two hooks edges from the agent', () => {
    const ids = deriveEdges(graph).map((e) => e.id);
    expect(ids).toContain('hooks:agent->hook:h1');
    expect(ids).toContain('hooks:agent->hook:h2');
  });

  it('reads the layout note as a note:n1 node at its saved position', () => {
    const note = graph.nodes.find((n) => n.id === 'note:n1');
    expect(note).toMatchObject({
      kind: 'note',
      owner: null,
      position: { x: 0, y: -160 },
    });
    expect((note!.data as NoteNodeData).text).toBe('Ask legal before enabling redact-pii');
  });

  it('round-trips to an identical spec and layout', () => {
    const result = graphToSpec(specToGraph(spec, WORKED_LAYOUT));
    expect(result.spec).toStrictEqual(spec);
    expect(result.layout.notes).toStrictEqual(WORKED_LAYOUT.notes);
  });
});

describe('connectNodes: agent → hook', () => {
  it('re-owns the hook to the connecting agent', () => {
    const g = specToGraph(
      specOf({
        hooks: [{ id: 'h1', file: 'hooks/a.ts' }],
        subagents: {
          r: {
            inline: { name: 'r', description: 'd', model: 'mock/mock-1', instructions: 'x' },
          },
        },
      }),
    );
    const result = connectNodes(g, 'sub:r', 'hook:h1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.graph.nodes.find((n) => n.id === 'hook:h1')!.owner).toBe('sub:r');
      const inline = graphToSpec(result.graph).spec.subagents?.['r'] as {
        inline: { hooks: unknown[] };
      };
      expect(inline.inline.hooks).toStrictEqual([{ id: 'h1', file: 'hooks/a.ts' }]);
    }
  });
});

describe('hookRules.validate', () => {
  it.each(['', '/etc/h.ts', 'C:/h.ts', '../h.ts', 'hooks/h.py', 'hooks/h', 'hooks\\h.ts'])(
    'flags file %j',
    (file) => {
      const g = graphOf([{ id: 'h1', file }]);
      expect(validateGraph(g)).toStrictEqual([
        error('hook:h1', 'Use a .ts or .js file inside the agent folder', 'hooks[0].file'),
      ]);
    },
  );

  it('accepts .ts and .js files inside the agent folder', () => {
    const g = graphOf([
      { id: 'h1', file: 'hooks/loop-guard.ts' },
      { id: 'h2', file: 'hooks/audit.js' },
    ]);
    expect(validateGraph(g)).toStrictEqual([]);
  });

  it('flags an inline hook with an empty name', () => {
    const g = graphOf([
      { id: 'h1', inline: { name: '  ', point: 'preToolCall', code: 'return ctx;' } },
    ]);
    expect(validateGraph(g)).toStrictEqual([
      error('hook:h1', 'The hook needs a name', 'hooks[0].inline.name'),
    ]);
  });

  it('flags an enabled inline hook with no code', () => {
    const g = graphOf([
      { id: 'h1', inline: { name: 'audit', point: 'postToolCall', code: '  ' } },
    ]);
    expect(validateGraph(g)).toStrictEqual([
      error('hook:h1', 'This hook is on but has no code', 'hooks[0].inline.code'),
    ]);
  });

  it('accepts an empty code body while the hook is off', () => {
    const g = graphOf([
      { id: 'h1', inline: { name: 'audit', point: 'postToolCall', code: '', enabled: false } },
    ]);
    expect(validateGraph(g)).toStrictEqual([]);
  });

  it('flags an id outside the spec pattern', () => {
    const g = specToGraph(specOf({ hooks: [{ id: 'has space', file: 'hooks/a.ts' }] }));
    const node = g.nodes.find((n) => n.kind === 'hook')!;
    expect(validateGraph(g)).toStrictEqual([
      error(node.id, 'The id can use letters, digits, dash or underscore', 'hooks[0].id'),
    ]);
  });

  it('maps problems to the nested spec path inside an inline agent', () => {
    const g = specToGraph(
      specOf({
        subagents: {
          r: {
            inline: {
              name: 'r',
              description: 'd',
              model: 'mock/mock-1',
              instructions: 'x',
              hooks: [{ id: 'h1', file: '../x.py' }],
            },
          },
        },
      }),
    );
    expect(validateGraph(g)).toStrictEqual([
      error(
        'sub:r/hook:h1',
        'Use a .ts or .js file inside the agent folder',
        'subagents.r.inline.hooks[0].file',
      ),
    ]);
  });
});

describe('hookRules.duplicateData', () => {
  it('gives the copy the next free h id', () => {
    const g = graphOf([
      { id: 'h1', file: 'hooks/a.ts' },
      { id: 'h2', inline: { name: 'audit', point: 'postToolCall', code: 'return ctx;' } },
    ]);
    const result = duplicateNode(g, 'hook:h2');
    expect(result.nodeId).toBe('hook:h3');
    const copy = result.graph.nodes.find((n) => n.id === 'hook:h3')!;
    expect((copy.data as HookNodeData).item).toStrictEqual({
      id: 'h3',
      inline: { name: 'audit', point: 'postToolCall', code: 'return ctx;' },
    });
  });
});
