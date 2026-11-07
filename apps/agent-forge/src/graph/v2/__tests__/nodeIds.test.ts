import { describe, expect, it } from 'vitest';

import {
  baseNodeId,
  childPrefix,
  dedupeId,
  nextItemId,
  skillNodeName,
  toolNodeName,
  uniqueName,
} from '../nodeIds';
import type { AgentFields, GraphNode } from '../types';

/** Smallest valid `AgentNodeData.fields` for tests that never inspect the fields. */
const AGENT_FIELDS: AgentFields = { name: 'a', model: 'mock/mock-1', instructions: 'hi' };

describe('toolNodeName', () => {
  it('uses the builtin name', () => {
    expect(toolNodeName({ builtin: 'http' })).toBe('http');
  });

  it('prefers an explicit id over the builtin name', () => {
    expect(toolNodeName({ builtin: 'http', id: 'fetcher' })).toBe('fetcher');
  });

  it('uses the registry name', () => {
    expect(toolNodeName({ registry: 'github-issues' })).toBe('github-issues');
  });

  it('uses the hosted tool name', () => {
    expect(toolNodeName({ hosted: 'web_search' })).toBe('web_search');
  });

  it('uses the file basename without extension', () => {
    expect(toolNodeName({ file: 'tools/search.ts' })).toBe('search');
  });

  it('uses the integration name', () => {
    expect(toolNodeName({ integration: 'github', credentials: {} })).toBe('github');
  });

  it("uses 'openapi' for an openapi ref", () => {
    expect(toolNodeName({ openapi: { url: 'https://x' } })).toBe('openapi');
  });

  it("uses 'hub' for a hub ref", () => {
    expect(toolNodeName({ hub: true })).toBe('hub');
  });

  it("falls back to 'new' when the resolved name is empty", () => {
    expect(toolNodeName({ builtin: '' })).toBe('new');
  });
});

describe('skillNodeName', () => {
  it('uses the inline skill name', () => {
    expect(skillNodeName({ inline: { name: 'reviewer', description: 'd', content: 'c' } })).toBe('reviewer');
  });

  it('uses the directory basename, ignoring a trailing slash', () => {
    expect(skillNodeName({ dir: 'skills/review/' })).toBe('review');
  });

  it('uses the registry name', () => {
    expect(skillNodeName({ registry: 'changelog' })).toBe('changelog');
  });
});

describe('childPrefix', () => {
  it('is empty for the root agent', () => {
    expect(childPrefix('agent')).toBe('');
  });

  it('is the owner id plus a slash for an inline subagent owner', () => {
    expect(childPrefix('sub:research')).toBe('sub:research/');
  });
});

describe('baseNodeId', () => {
  const cases: Array<[GraphNode['kind'], GraphNode['data'], string | null, string]> = [
    ['agent', { fields: AGENT_FIELDS, extra: {} }, 'agent', 'agent'],
    ['subagent', { key: 'research', item: { ref: 'agents/r.yaml' } }, 'agent', 'sub:research'],
    ['tool', { item: { builtin: 'http' } }, 'agent', 'tool:http'],
    ['mcp', { key: 'gh', item: { command: 'gh-mcp' } }, 'agent', 'mcp:gh'],
    ['skill', { item: { registry: 'changelog' } }, 'agent', 'skill:changelog'],
    [
      'memory',
      { item: { name: 'mem', scope: 'global', provider: { type: 'in-memory' } } },
      'agent',
      'memory:mem',
    ],
    ['handoff', { item: { agent: 'helper' } }, 'agent', 'handoff:helper'],
    ['guardrail', { item: { id: 'g1', name: 'regex' } }, 'agent', 'guard:g1'],
    ['permission', { item: { id: 'p1', tool: '*', action: 'allow' } }, 'agent', 'perm:p1'],
    ['hook', { item: { id: 'h1', file: 'hooks/a.ts' } }, 'agent', 'hook:h1'],
    ['output', { item: { jsonSchema: { type: 'object' } } }, 'agent', 'output'],
    ['trigger', { item: { id: 't1', type: 'chat' } }, 'agent', 'trigger:t1'],
    [
      'abort',
      { item: { id: 'a1', triggerId: 't1', when: 'w', match: 'm', scope: 'both' } },
      'agent',
      'abort:a1',
    ],
    ['flow', { step: { type: 'agentStep', id: 's1' }, children: { shape: 'none' } }, 'agent', 'flow:s1'],
    ['note', { text: 'hi' }, null, 'note:'],
  ];

  it.each(cases)('kind %s at root -> %s', (kind, data, ownerId, expected) => {
    expect(baseNodeId(kind, data, ownerId)).toBe(expected);
  });

  it('prefixes capability nodes of an inline subagent with its id', () => {
    expect(baseNodeId('tool', { item: { builtin: 'http' } }, 'sub:research')).toBe('sub:research/tool:http');
    expect(baseNodeId('mcp', { key: 'gh', item: { command: 'gh-mcp' } }, 'sub:research')).toBe('sub:research/mcp:gh');
    expect(baseNodeId('skill', { item: { registry: 'changelog' } }, 'sub:research')).toBe(
      'sub:research/skill:changelog',
    );
    expect(
      baseNodeId(
        'memory',
        { item: { name: 'mem', scope: 'global', provider: { type: 'in-memory' } } },
        'sub:research',
      ),
    ).toBe('sub:research/memory:mem');
    expect(baseNodeId('handoff', { item: { agent: 'helper' } }, 'sub:research')).toBe(
      'sub:research/handoff:helper',
    );
    expect(baseNodeId('guardrail', { item: { id: 'g1', name: 'regex' } }, 'sub:research')).toBe(
      'sub:research/guard:g1',
    );
    expect(
      baseNodeId('permission', { item: { id: 'p1', tool: '*', action: 'allow' } }, 'sub:research'),
    ).toBe('sub:research/perm:p1');
    expect(baseNodeId('hook', { item: { id: 'h1', file: 'hooks/a.ts' } }, 'sub:research')).toBe(
      'sub:research/hook:h1',
    );
    expect(baseNodeId('output', { item: { jsonSchema: {} } }, 'sub:research')).toBe('sub:research/output');
    expect(baseNodeId('subagent', { key: 'nested', item: { ref: 'a.yaml' } }, 'sub:research')).toBe(
      'sub:research/sub:nested',
    );
  });

  it('nests an inline subagent under its owner prefix', () => {
    expect(
      baseNodeId('agent', { fields: AGENT_FIELDS, extra: {}, subagentKey: 'b' }, 'sub:a'),
    ).toBe('sub:a/sub:b');
  });

  it('keeps trigger and abort unprefixed (root-only sections)', () => {
    expect(baseNodeId('trigger', { item: { id: 't1', type: 'chat' } }, 'sub:research')).toBe('trigger:t1');
    expect(
      baseNodeId(
        'abort',
        { item: { id: 'a1', triggerId: 't1', when: 'w', match: 'm', scope: 'both' } },
        'sub:research',
      ),
    ).toBe('abort:a1');
  });
});

describe('dedupeId', () => {
  it('returns the base id when it is free', () => {
    expect(dedupeId('tool:http', new Set())).toBe('tool:http');
  });

  it('appends #2 when the base is taken, then #3', () => {
    expect(dedupeId('tool:http', new Set(['tool:http']))).toBe('tool:http#2');
    expect(dedupeId('tool:http', new Set(['tool:http', 'tool:http#2']))).toBe('tool:http#3');
  });
});

describe('nextItemId', () => {
  it('returns the lowest free id with the prefix', () => {
    expect(nextItemId('g', ['g1', 'g3'])).toBe('g2');
  });

  it('starts at 1 for an empty list', () => {
    expect(nextItemId('t', [])).toBe('t1');
  });
});

describe('uniqueName', () => {
  it('returns the base name when it is free', () => {
    expect(uniqueName('server', [])).toBe('server');
  });

  it('appends -2, -3 until free', () => {
    expect(uniqueName('server', ['server'])).toBe('server-2');
    expect(uniqueName('server', ['server', 'server-2'])).toBe('server-3');
  });
});
