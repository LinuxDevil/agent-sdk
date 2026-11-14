import { describe, expect, it } from 'vitest';

import { schemaProblems, formatIssuePath } from '../schemaIssues';
import { specToGraph } from '../specToGraph';
import { validateGraph } from '../validateGraph';
import type { AgentSpecV2 } from '../specTypes';

/** A minimal spec that passes the AgentSpec v2 schema. */
function specOf(over: Record<string, unknown> = {}): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/mock-1', instructions: 'x', ...over } as AgentSpecV2;
}

/** The specPaths `graphToSpec` reports for a spec's nodes, root agent first. */
const PATHS = {
  agent: '',
  'tool:search': 'tools[0]',
  'sub:research/tool:fetch': 'subagents.research.inline.tools[0]',
  'mcp:linear': 'mcpServers.linear',
};

describe('formatIssuePath', () => {
  it('joins segments with dots and numbers with [n] subscripts', () => {
    expect(formatIssuePath([])).toBe('');
    expect(formatIssuePath(['name'])).toBe('name');
    expect(formatIssuePath(['tools', 2, 'builtin'])).toBe('tools[2].builtin');
    expect(formatIssuePath(['a', 'b', 0, 'c'])).toBe('a.b[0].c');
    expect(formatIssuePath(['mcpServers', 'linear', 'oauth', 'clientId'])).toBe(
      'mcpServers.linear.oauth.clientId',
    );
  });
});

describe('schemaProblems', () => {
  it('returns no problems for a schema-valid spec', () => {
    expect(schemaProblems(specOf(), PATHS)).toEqual([]);
  });

  it('maps a top-level issue to the root agent through the empty spec path', () => {
    const problems = schemaProblems(specOf({ 'x-team': 'platform' } as Record<string, unknown>), PATHS);
    expect(problems).toEqual([
      expect.objectContaining({ nodeId: 'agent', severity: 'error', fieldPath: '' }),
    ]);
    expect(problems[0].message).toContain('x-team');
  });

  it('maps a keyed-list item issue to its node (longest prefix wins)', () => {
    const spec = specOf({
      tools: [{ builtin: 'not_a_builtin' }],
      subagents: {
        research: { inline: { tools: [{ builtin: 'also_bad' }] } },
      },
      mcpServers: { linear: { url: 'not a url' } },
    });
    const problems = schemaProblems(spec, PATHS);
    const byPath = new Map(problems.map((p) => [p.fieldPath, p.nodeId]));
    expect(byPath.get('tools[0].builtin')).toBe('tool:search');
    expect(byPath.get('subagents.research.inline.tools[0].builtin')).toBe('sub:research/tool:fetch');
    expect(byPath.get('mcpServers.linear.url')).toBe('mcp:linear');
  });

  it('reports "not supported yet" issues as warnings', () => {
    const problems = schemaProblems(
      specOf({ guardrails: [{ id: 'g1', name: 'pii', onTripped: 'warn' }] }),
      PATHS,
    );
    expect(problems).toEqual([
      {
        nodeId: 'agent',
        severity: 'warning',
        message: 'This setting is not supported yet: guardrails[0].onTripped',
        fieldPath: 'guardrails[0].onTripped',
      },
    ]);
  });
});

describe('validateGraph schema integration', () => {
  it('drops a schema problem that duplicates a kind problem on the same node and field path', () => {
    // A webhook trigger without promptTemplate: the kind rule reports
    // 'triggers[0].promptTemplate' on trigger:t1 and the schema reports the
    // same path — the schema copy must not double the row.
    const graph = specToGraph(
      specOf({ triggers: [{ id: 't1', type: 'webhook', path: '/hooks/x' }] }),
    );
    const problems = validateGraph(graph);
    const at = problems.filter((p) => p.fieldPath === 'triggers[0].promptTemplate');
    expect(at).toHaveLength(1);
    expect(at[0]).toMatchObject({ nodeId: 'trigger:t1', severity: 'error' });
  });

  it('keeps schema problems the kind rules do not cover', () => {
    const graph = specToGraph(specOf({ 'x-team': 'platform' }));
    const problems = validateGraph(graph);
    expect(problems.some((p) => p.nodeId === 'agent' && p.fieldPath === '')).toBe(true);
  });
});
