import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { deriveEdges } from '../../edges';
import { graphToSpec } from '../../graphToSpec';
import { duplicateNode } from '../../mutations';
import { specToGraph } from '../../specToGraph';
import type { AgentSpecV2 } from '../../specTypes';
import type { Graph, McpNodeData, Problem } from '../../types';
import { validateGraph } from '../../validateGraph';

/** The ticket's worked example: a stdio server with a secret env and a tools filter, and an http server with a secret header and annotations approval. */
const WORKED = `version: 2
name: support-bot
model: anthropic/claude-sonnet-5-5
instructions: Answer tickets.
mcpServers:
  github:
    command: npx
    args: [-y, '@modelcontextprotocol/server-github']
    env: { GITHUB_TOKEN: { secret: gh-token } }
    tools: { exclude: [delete_repo] }
  linear:
    url: https://mcp.linear.app/sse
    headers: { Authorization: { env: LINEAR_AUTH } }
    approval: annotations
`;

const WORKED_IDS = ['agent', 'mcp:github', 'mcp:linear'];

function specOf(over: Record<string, unknown>): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', ...over } as AgentSpecV2;
}

function graphOf(mcpServers: Record<string, unknown>): Graph {
  return specToGraph(specOf({ mcpServers }));
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

describe('specToGraph: mcp worked example', () => {
  const graph = specToGraph(parse(WORKED) as AgentSpecV2);

  it('produces the two mcp nodes with the listed ids, in order', () => {
    expect(graph.nodes.map((n) => n.id)).toEqual(WORKED_IDS);
  });

  it('keeps each record entry as { key, item }, owned by the root agent', () => {
    const spec = parse(WORKED) as AgentSpecV2;
    const entries = Object.entries(spec.mcpServers ?? {});
    for (const [i, node] of graph.nodes.slice(1).entries()) {
      expect(node.owner).toBe('agent');
      expect(node.kind).toBe('mcp');
      const data = node.data as McpNodeData;
      expect(data.key).toBe(entries[i][0]);
      expect(data.item).toStrictEqual(entries[i][1]);
    }
  });

  it('derives a uses edge from the agent to every server', () => {
    const ids = deriveEdges(graph).map((e) => e.id);
    expect(ids).toContain('uses:agent->mcp:github');
    expect(ids).toContain('uses:agent->mcp:linear');
  });

  it('round-trips to an identical spec', () => {
    const spec = parse(WORKED) as AgentSpecV2;
    expect(graphToSpec(specToGraph(spec)).spec).toStrictEqual(spec);
  });
});

describe('mcpRules.validate', () => {
  it('requires a command on a stdio entry', () => {
    const graph = graphOf({ fs: { command: '' } });
    expect(validateGraph(graph, { schema: false })).toStrictEqual([
      error('mcp:fs', 'Enter the command that starts the server', 'mcpServers.fs.command'),
    ]);
  });

  it.each(['', 'not a url', 'mcp.example.com/sse'])('rejects the http url %j', (url) => {
    const graph = graphOf({ linear: { url } });
    expect(validateGraph(graph, { schema: false })).toStrictEqual([
      error('mcp:linear', 'Enter the server URL', 'mcpServers.linear.url'),
    ]);
  });

  it.each(['https://mcp.linear.app/sse', 'http://localhost:3000/mcp'])('accepts the url %j', (url) => {
    const graph = graphOf({ linear: { url } });
    expect(validateGraph(graph, { schema: false })).toStrictEqual([]);
  });

  it.each(['bad key!', 'key?', 'x'.repeat(65)])('rejects the server name %j', (key) => {
    const graph = graphOf({ [key]: { command: 'x' } });
    expect(validateGraph(graph, { schema: false })).toStrictEqual([
      error(`mcp:${key}`, 'The server name can use letters, digits, dash or underscore', `mcpServers.${key}`),
    ]);
  });

  it('rejects oauth.clientSecret without oauth.clientId', () => {
    const graph = graphOf({
      linear: {
        url: 'https://mcp.linear.app/sse',
        oauth: { redirectUri: 'https://app.example.com/cb', clientSecret: { secret: 'lin-secret' } },
      },
    });
    expect(validateGraph(graph, { schema: false })).toStrictEqual([
      error(
        'mcp:linear',
        'Set the client id before the client secret',
        'mcpServers.linear.oauth.clientSecret',
      ),
    ]);
  });

  it.each([undefined, ''])('rejects oauth without a redirect URI (redirectUri %j)', (redirectUri) => {
    const oauth = redirectUri === undefined ? { clientId: 'c1' } : { redirectUri, clientId: 'c1' };
    const graph = graphOf({ linear: { url: 'https://mcp.linear.app/sse', oauth } });
    expect(validateGraph(graph, { schema: false })).toStrictEqual([
      error('mcp:linear', 'OAuth needs a redirect URI', 'mcpServers.linear.oauth.redirectUri'),
    ]);
  });

  it('warns when an env value under a secret-sounding key is a plain string', () => {
    const graph = graphOf({ fs: { command: 'x', env: { GITHUB_TOKEN: 'literal', PLAIN: 'ok' } } });
    expect(validateGraph(graph, { schema: false })).toStrictEqual([
      warning('mcp:fs', 'Store this value as a secret', 'mcpServers.fs.env.GITHUB_TOKEN'),
    ]);
  });

  it('warns when a header value under a secret-sounding key is a plain string', () => {
    const graph = graphOf({
      linear: { url: 'https://mcp.linear.app/sse', headers: { Authorization: 'literal' } },
    });
    expect(validateGraph(graph, { schema: false })).toStrictEqual([
      warning('mcp:linear', 'Store this value as a secret', 'mcpServers.linear.headers.Authorization'),
    ]);
  });

  it('accepts secret refs under secret-sounding keys', () => {
    const graph = graphOf({
      fs: { command: 'x', env: { GITHUB_TOKEN: { secret: 'gh' } } },
      linear: { url: 'https://mcp.linear.app/sse', headers: { Authorization: { env: 'LIN' } } },
    });
    expect(validateGraph(graph, { schema: false })).toStrictEqual([]);
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
              mcpServers: { fs: { command: '' } },
            },
          },
        },
      }),
    );
    expect(validateGraph(graph, { schema: false })).toStrictEqual([
      error(
        'sub:a/mcp:fs',
        'Enter the command that starts the server',
        'subagents.a.inline.mcpServers.fs.command',
      ),
    ]);
  });
});

describe('mcpRules.duplicateData', () => {
  it('rekeys the copy <key>-copy, then -copy-2', () => {
    const g = graphOf({ github: { command: 'npx' } });
    const first = duplicateNode(g, 'mcp:github');
    expect(first.nodeId).toBe('mcp:github-copy');
    const second = duplicateNode(first.graph, 'mcp:github');
    expect(second.nodeId).toBe('mcp:github-copy-2');
    const copy = first.graph.nodes.find((n) => n.id === 'mcp:github-copy')!;
    expect((copy.data as McpNodeData).item).toStrictEqual({ command: 'npx' });
  });
});
