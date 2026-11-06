import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { deriveEdges } from '../../edges';
import { graphToSpec } from '../../graphToSpec';
import { specToGraph } from '../../specToGraph';
import type { AgentSpecV2, ToolRef } from '../../specTypes';
import type { Problem } from '../../types';
import { validateGraph } from '../../validateGraph';

/** The ticket's worked example: one entry per `ToolRef` form, plus a second built-in with an `id`. */
const WORKED = `version: 2
name: support-bot
model: anthropic/claude-sonnet-5-5
instructions: Answer tickets.
tools:
  - builtin: web-fetch
    approval: always
  - registry: github-issues
    version: 1.2.0
  - file: tools/search.ts
  - integration: github
    credentials: { token: { secret: gh-token }, owner: acme, repo: api }
  - openapi:
      url: https://api.example.com/openapi.json
      include: [getOrder]
      approval: mutating
      bearerToken: { env: SHOP_TOKEN }
  - hosted: web_search
  - hub: true
  - builtin: web-fetch
    id: fetch-docs
`;

const WORKED_IDS = [
  'agent',
  'tool:web-fetch',
  'tool:github-issues',
  'tool:search',
  'tool:github',
  'tool:openapi',
  'tool:web_search',
  'tool:hub',
  'tool:fetch-docs',
];

function specOf(over: Record<string, unknown>): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', ...over } as AgentSpecV2;
}

function graphOf(tools: ToolRef[]): ReturnType<typeof specToGraph> {
  return specToGraph(specOf({ tools }));
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

describe('specToGraph: tool worked example', () => {
  const graph = specToGraph(parse(WORKED) as AgentSpecV2);

  it('produces the eight tool nodes with the listed ids, in order', () => {
    expect(graph.nodes.map((n) => n.id)).toEqual(WORKED_IDS);
  });

  it('keeps each spec entry verbatim as data.item, owned by the root agent', () => {
    const spec = parse(WORKED) as AgentSpecV2;
    const tools = spec.tools ?? [];
    for (const [i, node] of graph.nodes.slice(1).entries()) {
      expect(node.owner).toBe('agent');
      expect(node.kind).toBe('tool');
      expect((node.data as { item: unknown }).item).toStrictEqual(tools[i]);
    }
  });

  it('derives a uses edge from the agent to every tool', () => {
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

describe('toolRules.validate', () => {
  it('requires a built-in name', () => {
    const graph = graphOf([{ builtin: '' }]);
    expect(validateGraph(graph)).toStrictEqual([
      error('tool:new', 'Pick a tool', 'tools[0].builtin'),
    ]);
  });

  it('requires a registry name', () => {
    const graph = graphOf([{ registry: '' }]);
    expect(validateGraph(graph)).toStrictEqual([
      error('tool:new', 'Enter the registry item name', 'tools[0].registry'),
    ]);
  });

  it.each([
    ['', 'tool:new'],
    ['/abs/x.ts', 'tool:x'],
    ['../x.ts', 'tool:x'],
    ['a/../x.ts', 'tool:x'],
    ['x.txt', 'tool:x'],
    ['x.py', 'tool:x'],
    ['C:\\x.ts', 'tool:x'],
  ])('rejects the file path %j', (file, nodeId) => {
    const graph = graphOf([{ file }]);
    expect(validateGraph(graph)).toStrictEqual([
      error(nodeId, 'Use a .ts or .js file inside the agent folder', 'tools[0].file'),
    ]);
  });

  it.each(['tools/search.ts', 'search.js', 'tools/deep/search.ts'])('accepts the file path %j', (file) => {
    const graph = graphOf([{ file }]);
    expect(validateGraph(graph)).toStrictEqual([]);
  });

  it('requires integration credentials', () => {
    const graph = graphOf([{ integration: 'github', credentials: {} }]);
    expect(validateGraph(graph)).toStrictEqual([
      error('tool:github', 'Add the credentials this integration needs', 'tools[0].credentials'),
    ]);
  });

  it.each(['', 'not a url', 'api.example.com/openapi.json'])(
    'rejects the OpenAPI url %j',
    (url) => {
      const graph = graphOf([{ openapi: { url } }]);
      expect(validateGraph(graph)).toStrictEqual([
        error('tool:openapi', 'Enter the OpenAPI document URL', 'tools[0].openapi.url'),
      ]);
    },
  );

  it('requires a hosted tool name', () => {
    const graph = graphOf([{ hosted: '' as never }]);
    expect(validateGraph(graph)).toStrictEqual([
      error('tool:new', 'Pick a provider-hosted tool', 'tools[0].hosted'),
    ]);
  });

  it('rejects an id outside the spec-id pattern', () => {
    const graph = graphOf([{ builtin: 'web_fetch', id: 'bad id!' }]);
    expect(validateGraph(graph)).toStrictEqual([
      error('tool:bad id!', 'The node id can use letters, digits, dash or underscore', 'tools[0].id'),
    ]);
  });

  it('warns when two id-less tools share a name under one owner', () => {
    const graph = graphOf([{ builtin: 'web_fetch' }, { builtin: 'web_fetch' }]);
    expect(validateGraph(graph)).toStrictEqual([
      warning('tool:web_fetch', 'This tool is added twice', 'tools[0]'),
      warning('tool:web_fetch#2', 'This tool is added twice', 'tools[1]'),
    ]);
  });

  it('does not warn when the repeat carries an id', () => {
    const graph = graphOf([{ builtin: 'web_fetch' }, { builtin: 'web_fetch', id: 'fetch-docs' }]);
    expect(validateGraph(graph)).toStrictEqual([]);
  });

  it.each([
    ['token', 'github'],
    ['apiToken', 'jira'],
    ['webhookUrl', 'slack'],
    ['apiKey', 'email'],
  ] as const)(
    'warns when the %s credential is a plain string',
    (key, integration) => {
      const graph = graphOf([{ integration, credentials: { [key]: 'literal' } }]);
      expect(validateGraph(graph)).toStrictEqual([
        warning(`tool:${integration}`, 'Store this credential as a secret', `tools[0].credentials.${key}`),
      ]);
    },
  );

  it('accepts secret refs and plain strings for non-secret keys', () => {
    const graph = graphOf([
      {
        integration: 'github',
        credentials: { token: { secret: 'gh-token' }, owner: 'acme', repo: 'api' },
      },
    ]);
    expect(validateGraph(graph)).toStrictEqual([]);
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
              tools: [{ builtin: '' }],
            },
          },
        },
      }),
    );
    expect(validateGraph(graph)).toStrictEqual([
      error('sub:a/tool:new', 'Pick a tool', 'subagents.a.inline.tools[0].builtin'),
    ]);
  });
});
