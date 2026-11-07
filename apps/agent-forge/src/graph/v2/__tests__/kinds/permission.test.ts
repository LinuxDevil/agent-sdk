import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { deriveEdges } from '../../edges';
import { graphToSpec } from '../../graphToSpec';
import { connectNodes, duplicateNode } from '../../mutations';
import { specToGraph } from '../../specToGraph';
import type { AgentSpecV2 } from '../../specTypes';
import type { Graph, PermissionNodeData, Problem } from '../../types';
import { validateGraph } from '../../validateGraph';

/** The ticket's worked example: one ask rule over every github tool, one deny rule over http's internal urls. */
const WORKED = `version: 2
name: support-bot
model: anthropic/claude-sonnet-5-5
instructions: Answer tickets.
tools:
  - { builtin: http }
mcpServers:
  github: { command: npx }
permissions:
  - { id: p1, tool: 'github__*', action: ask, reason: Changes code }
  - id: p2
    tool: [http]
    when: { url: { matches: '^https://internal\\.' } }
    action: deny
`;

const WORKED_IDS = ['agent', 'tool:http', 'mcp:github', 'perm:p1', 'perm:p2'];

function specOf(over: Record<string, unknown>): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', ...over } as AgentSpecV2;
}

function graphOf(permissions: Record<string, unknown>[], over: Record<string, unknown> = {}): Graph {
  return specToGraph(specOf({ permissions, ...over }));
}

function problem(
  nodeId: string,
  severity: 'error' | 'warning',
  message: string,
  fieldPath: string,
): Problem {
  return { nodeId, severity, message, fieldPath };
}

function error(nodeId: string, message: string, fieldPath: string): Problem {
  return problem(nodeId, 'error', message, fieldPath);
}

function warning(nodeId: string, message: string, fieldPath: string): Problem {
  return problem(nodeId, 'warning', message, fieldPath);
}

const item = (graph: Graph, id: string) =>
  (graph.nodes.find((n) => n.id === id)!.data as PermissionNodeData).item;

describe('specToGraph: permission worked example', () => {
  const graph = specToGraph(parse(WORKED) as AgentSpecV2);

  it('produces the two perm nodes with the listed ids, in order', () => {
    expect(graph.nodes.map((n) => n.id)).toEqual(WORKED_IDS);
  });

  it('keeps each rule as { item }, owned by the root agent', () => {
    const spec = parse(WORKED) as AgentSpecV2;
    const rules = spec.permissions ?? [];
    for (const [i, node] of graph.nodes.slice(3).entries()) {
      expect(node.owner).toBe('agent');
      expect(node.kind).toBe('permission');
      expect((node.data as PermissionNodeData).item).toStrictEqual(rules[i]);
    }
  });

  it('draws the two governs edges', () => {
    const ids = deriveEdges(graph).map((e) => e.id);
    expect(ids).toContain('governs:mcp:github->perm:p1');
    expect(ids).toContain('governs:tool:http->perm:p2');
  });

  it('falls back to an owner governs edge when nothing matches', () => {
    const g = graphOf([{ id: 'p1', tool: 'nothing-matches', action: 'allow' }]);
    expect(deriveEdges(g).map((e) => e.id)).toContain('governs:agent->perm:p1');
  });

  it('round-trips to an identical spec', () => {
    const spec = parse(WORKED) as AgentSpecV2;
    expect(graphToSpec(specToGraph(spec)).spec).toStrictEqual(spec);
  });
});

describe('connectNodes: tool → permission', () => {
  it('appends the tool name, turning a string tool into an array', () => {
    const g = graphOf(
      [{ id: 'p2', tool: ['http'], action: 'deny' }],
      { tools: [{ builtin: 'http' }, { builtin: 'web-fetch' }] },
    );
    const result = connectNodes(g, 'tool:web-fetch', 'perm:p2');
    expect(result.ok).toBe(true);
    if (result.ok) expect(item(result.graph, 'perm:p2').tool).toStrictEqual(['http', 'web-fetch']);
  });

  it('appends to a string tool as a two-entry array', () => {
    const g = graphOf(
      [{ id: 'p1', tool: 'http', action: 'ask' }],
      { tools: [{ builtin: 'http' }, { builtin: 'web-fetch' }] },
    );
    const result = connectNodes(g, 'tool:web-fetch', 'perm:p1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(item(result.graph, 'perm:p1').tool).toStrictEqual(['http', 'web-fetch']);
  });

  it('refuses when a pattern already covers the tool', () => {
    const g = graphOf(
      [{ id: 'p2', tool: ['http', 'web-fetch'], action: 'deny' }],
      { tools: [{ builtin: 'http' }, { builtin: 'web-fetch' }] },
    );
    expect(connectNodes(g, 'tool:web-fetch', 'perm:p2')).toStrictEqual({
      ok: false,
      reason: 'This rule already covers web-fetch',
    });
  });

  it('refuses when a glob pattern already covers the tool', () => {
    const g = graphOf(
      [{ id: 'p1', tool: 'web-*', action: 'allow' }],
      { tools: [{ builtin: 'web-fetch' }] },
    );
    expect(connectNodes(g, 'tool:web-fetch', 'perm:p1')).toStrictEqual({
      ok: false,
      reason: 'This rule already covers web-fetch',
    });
  });

  it('refuses a permission owned by a different agent', () => {
    const g = specToGraph(
      specOf({
        tools: [{ builtin: 'http' }],
        subagents: {
          r: {
            inline: {
              name: 'r',
              description: 'd',
              model: 'mock/mock-1',
              instructions: 'x',
              permissions: [{ id: 'p1', tool: 'http', action: 'ask' }],
            },
          },
        },
      }),
    );
    expect(connectNodes(g, 'tool:http', 'sub:r/perm:p1')).toStrictEqual({
      ok: false,
      reason: 'A rule only governs tools of the same agent',
    });
  });
});

describe('connectNodes: mcp → permission', () => {
  it('appends the <key>__* pattern', () => {
    const g = graphOf([{ id: 'p1', tool: 'http', action: 'ask' }], {
      mcpServers: { github: { command: 'npx' } },
    });
    const result = connectNodes(g, 'mcp:github', 'perm:p1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(item(result.graph, 'perm:p1').tool).toStrictEqual(['http', 'github__*']);
  });

  it.each(['github__*', 'github__create_issue', '*'])(
    'refuses when tool %j already covers the server',
    (tool) => {
      const g = graphOf([{ id: 'p1', tool, action: 'ask' }], {
        mcpServers: { github: { command: 'npx' } },
      });
      expect(connectNodes(g, 'mcp:github', 'perm:p1')).toStrictEqual({
        ok: false,
        reason: 'This rule already covers github',
      });
    },
  );
});

describe('permissionRules.validate', () => {
  it.each(['', []])('requires a tool name or pattern (tool %j)', (tool) => {
    const g = graphOf([{ id: 'p1', tool, action: 'allow' }]);
    expect(validateGraph(g)).toStrictEqual([
      error('perm:p1', 'Add at least one tool name or pattern', 'permissions[0].tool'),
      warning('perm:p1', 'No tool on this agent matches this rule', 'permissions[0].tool'),
    ]);
  });

  it('requires an argument name on every when entry', () => {
    const g = graphOf([
      { id: 'p1', tool: 'http', when: { '': 'x', url: 'y' }, action: 'deny' },
    ]);
    expect(validateGraph(g)).toStrictEqual([
      error('perm:p1', 'A condition needs an argument name', 'permissions[0].when'),
      warning('perm:p1', 'No tool on this agent matches this rule', 'permissions[0].tool'),
    ]);
  });

  it.each(['lt', 'lte', 'gt', 'gte'] as const)('requires a number for %s', (op) => {
    const g = graphOf([
      { id: 'p1', tool: 'http', when: { retries: { [op]: 'many' } }, action: 'deny' },
    ]);
    expect(validateGraph(g)).toStrictEqual([
      error('perm:p1', `Use a number for ${op}`, 'permissions[0].when.retries'),
      warning('perm:p1', 'No tool on this agent matches this rule', 'permissions[0].tool'),
    ]);
  });

  it('requires matches to compile', () => {
    const g = graphOf([
      { id: 'p1', tool: 'http', when: { url: { matches: '[' } }, action: 'deny' },
    ]);
    expect(validateGraph(g)).toStrictEqual([
      error(
        'perm:p1',
        'The pattern for url is not a valid regular expression',
        'permissions[0].when.url',
      ),
      warning('perm:p1', 'No tool on this agent matches this rule', 'permissions[0].tool'),
    ]);
  });

  it('warns when no tool or MCP node of the owner matches', () => {
    const g = graphOf([{ id: 'p1', tool: 'jira__*', action: 'allow' }], {
      tools: [{ builtin: 'http' }],
      mcpServers: { github: { command: 'npx' } },
    });
    expect(validateGraph(g)).toStrictEqual([
      warning('perm:p1', 'No tool on this agent matches this rule', 'permissions[0].tool'),
    ]);
  });

  it.each([
    ['github__*', { mcpServers: { github: { command: 'npx' } } }],
    ['github__create_issue', { mcpServers: { github: { command: 'npx' } } }],
    ['http', { tools: [{ builtin: 'http' }] }],
    ['*', { tools: [{ builtin: 'http' }] }],
  ] as const)('does not warn when %j matches a sibling node', (tool, over) => {
    const g = graphOf([{ id: 'p1', tool, action: 'allow' }], over);
    expect(validateGraph(g)).toStrictEqual([]);
  });

  it.each(['allow', 'deny'] as const)('warns on ttlMs with action %s', (action) => {
    const g = graphOf([{ id: 'p1', tool: '*', action, ttlMs: 60000 }], {
      tools: [{ builtin: 'http' }],
    });
    expect(validateGraph(g)).toStrictEqual([
      warning(
        'perm:p1',
        'Remembering only applies to ask and model-decided rules',
        'permissions[0].ttlMs',
      ),
    ]);
  });

  it('accepts ttlMs on ask and auto rules', () => {
    const g = graphOf(
      [
        { id: 'p1', tool: '*', action: 'ask', ttlMs: 60000 },
        { id: 'p2', tool: '*', action: 'auto', ttlMs: 30000 },
      ],
      { tools: [{ builtin: 'http' }] },
    );
    expect(validateGraph(g)).toStrictEqual([]);
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
              permissions: [{ id: 'p1', tool: '', action: 'allow' }],
            },
          },
        },
      }),
    );
    expect(validateGraph(g)).toStrictEqual([
      error(
        'sub:r/perm:p1',
        'Add at least one tool name or pattern',
        'subagents.r.inline.permissions[0].tool',
      ),
      warning(
        'sub:r/perm:p1',
        'No tool on this agent matches this rule',
        'subagents.r.inline.permissions[0].tool',
      ),
    ]);
  });
});

describe('permissionRules.duplicateData', () => {
  it('gives the copy the next free p id', () => {
    const g = graphOf([
      { id: 'p1', tool: '*', action: 'ask' },
      { id: 'p2', tool: 'http', action: 'deny' },
    ]);
    const result = duplicateNode(g, 'perm:p1');
    expect(result.nodeId).toBe('perm:p3');
    const copy = result.graph.nodes.find((n) => n.id === 'perm:p3')!;
    expect((copy.data as PermissionNodeData).item).toStrictEqual({ id: 'p3', tool: '*', action: 'ask' });
  });
});

describe('addToolToRule refusals', () => {
  it("'*' already covers every tool", () => {
    const g = graphOf([{ id: 'p1', tool: '*', action: 'ask' }], {
      tools: [{ builtin: 'http' }],
    });
    expect(connectNodes(g, 'tool:http', 'perm:p1')).toStrictEqual({
      ok: false,
      reason: 'This rule already covers http',
    });
  });
});
