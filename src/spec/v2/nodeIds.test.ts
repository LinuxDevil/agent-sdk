import { describe, expect, it } from 'vitest';
import { specNodeIds } from './nodeIds';
import type { AgentSpecV2 } from './types';

function spec(overrides: Partial<AgentSpecV2> = {}): AgentSpecV2 {
  return { version: 2, name: 'a', model: 'mock/m', instructions: 'You are a test agent.', ...overrides };
}

describe('specNodeIds tools', () => {
  it('prefers the ref id, then builtin/registry/hosted/integration/file-basename/openapi/hub', () => {
    const ids = specNodeIds(
      spec({
        tools: [
          { builtin: 'web_fetch', id: 'fetch' },
          { builtin: 'current_date' },
          { registry: 'github-issues' },
          { hosted: 'web_search' },
          { integration: 'github', credentials: { token: { env: 'GH' }, owner: 'o', repo: 'r' } },
          { file: 'tools/lookup.ts' },
          { openapi: { url: 'https://x.test/openapi.json' } },
          { hub: true },
        ],
      })
    );
    expect(ids.tools).toEqual([
      'tool:fetch',
      'tool:current_date',
      'tool:github-issues',
      'tool:web_search',
      'tool:github',
      'tool:lookup',
      'tool:openapi',
      'tool:hub',
    ]);
  });

  it('dedupes repeated bases with #2, #3', () => {
    const ids = specNodeIds(
      spec({ tools: [{ builtin: 'http_request' }, { builtin: 'http_request' }, { builtin: 'http_request' }] })
    );
    expect(ids.tools).toEqual(['tool:http_request', 'tool:http_request#2', 'tool:http_request#3']);
  });

  it('strips only the last extension of a file basename', () => {
    const ids = specNodeIds(spec({ tools: [{ file: 'nested/deep/tool.v2.mts' }] }));
    expect(ids.tools).toEqual(['tool:tool.v2']);
  });
});

describe('specNodeIds remaining sections', () => {
  it('maps every mcp server key to mcp:<key>', () => {
    const ids = specNodeIds(
      spec({ mcpServers: { docs: { url: 'https://x.test/mcp' }, api: { command: 'run-it' } } })
    );
    expect(ids.mcp).toEqual({ docs: 'mcp:docs', api: 'mcp:api' });
  });

  it('names skills by inline name, dir basename or registry', () => {
    const ids = specNodeIds(
      spec({
        skills: [
          { inline: { name: 'changelog', description: 'Write changelogs.', content: '# C' } },
          { dir: 'skills/research' },
          { registry: 'pdf' },
        ],
      })
    );
    expect(ids.skills).toEqual(['skill:changelog', 'skill:research', 'skill:pdf']);
  });

  it('names memory slots memory:<name>', () => {
    const ids = specNodeIds(
      spec({
        memory: [
          { name: 'notes', scope: 'global', provider: { type: 'in-memory' } },
          { name: 'facts', scope: 'session', provider: { type: 'in-memory' } },
        ],
      })
    );
    expect(ids.memory).toEqual(['memory:notes', 'memory:facts']);
  });

  it('keys subagents by their spec.subagents name', () => {
    const ids = specNodeIds(
      spec({
        subagents: {
          research: { inline: { name: 'researcher', model: 'mock/m', instructions: 'R.', description: 'Finds.' } },
          remote: { remote: { url: 'https://x.test', description: 'Elsewhere.' } },
        },
      })
    );
    expect(ids.subagents).toEqual({ research: 'sub:research', remote: 'sub:remote' });
  });

  it('names handoffs handoff:<agent>', () => {
    const ids = specNodeIds(spec({ handoffs: [{ agent: 'billing' }, { agent: 'refunds', toolName: 'go_refunds' }] }));
    expect(ids.handoffs).toEqual(['handoff:billing', 'handoff:refunds']);
  });

  it('names guardrails, permissions, hooks and triggers by their id', () => {
    const ids = specNodeIds(
      spec({
        guardrails: [{ id: 'g1', name: 'deny-topics', options: { topics: ['x'] } }],
        permissions: [{ id: 'p1', tool: '*', action: 'allow' }],
        hooks: [
          { id: 'h1', file: 'hooks/pre.ts' },
          { id: 'h2', inline: { name: 'noop', point: 'postGenerate', code: 'return;' } },
        ],
        triggers: [
          { id: 't1', type: 'chat' },
          { id: 't2', type: 'cron', cron: '* * * * *', prompt: 'ping' },
        ],
      })
    );
    expect(ids.guardrails).toEqual(['guard:g1']);
    expect(ids.permissions).toEqual(['perm:p1']);
    expect(ids.hooks).toEqual(['hook:h1', 'hook:h2']);
    expect(ids.triggers).toEqual(['trigger:t1', 'trigger:t2']);
  });

  it('names abort listeners abort:<id>', () => {
    // abortListeners is `never` in the merged types (R03); specNodeIds still maps supplied data.
    const ids = specNodeIds(spec({ abortListeners: [{ id: 'a1' }] as never }));
    expect(ids.abortListeners).toEqual(['abort:a1']);
  });
});

describe('specNodeIds flow walk', () => {
  it('collects every step id of spec.flow.flow depth-first through steps, options[].step and step', () => {
    const flow = {
      flow: {
        type: 'sequence',
        steps: [
          { type: 'llmCall', id: 'classify' },
          {
            type: 'oneOf',
            id: 'route',
            options: [
              { condition: 'x', step: { type: 'return', id: 'billing' } },
              { step: { type: 'return', id: 'other' } },
            ],
          },
          { type: 'forEach', id: 'each', step: { type: 'toolCall', id: 'work' } },
        ],
      },
    };
    const ids = specNodeIds(spec({ flow } as never));
    expect(ids.flow).toEqual({
      classify: 'flow:classify',
      route: 'flow:route',
      billing: 'flow:billing',
      other: 'flow:other',
      each: 'flow:each',
      work: 'flow:work',
    });
  });
});

describe('specNodeIds empty spec', () => {
  it('returns empty sections for a minimal spec', () => {
    expect(specNodeIds(spec())).toEqual({
      tools: [],
      mcp: {},
      skills: [],
      memory: [],
      subagents: {},
      handoffs: [],
      guardrails: [],
      permissions: [],
      hooks: [],
      triggers: [],
      abortListeners: [],
      flow: {},
    });
  });
});
