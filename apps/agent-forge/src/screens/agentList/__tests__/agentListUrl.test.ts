import { describe, expect, it } from 'vitest';

import type { AgentListItem } from '../../../../shared/wireTypes';
import { filterAgents, labelOptions, parseAgentListQuery } from '../agentListUrl';

const item = (over: Partial<AgentListItem>): AgentListItem => ({
  id: 'agent',
  name: 'Agent',
  description: '',
  model: 'anthropic/claude-sonnet-5-5',
  enabled: true,
  labels: [],
  updatedAt: '2026-10-29T11:00:00Z',
  publishedVersion: null,
  counts: { tools: 0, mcpServers: 0, subagents: 0, triggers: 0 },
  ...over,
});

describe('parseAgentListQuery', () => {
  it('reads q, the comma-separated label set and enabled', () => {
    expect(parseAgentListQuery(new URLSearchParams('q=Bot&label=b,a&enabled=off'))).toEqual({
      q: 'Bot',
      labels: ['b', 'a'],
      enabled: 'off',
    });
  });

  it('drops an unknown enabled value and absent keys', () => {
    expect(parseAgentListQuery(new URLSearchParams('enabled=maybe'))).toEqual({
      q: '',
      labels: [],
      enabled: undefined,
    });
    expect(parseAgentListQuery(new URLSearchParams())).toEqual({ q: '', labels: [], enabled: undefined });
  });
});

describe('filterAgents', () => {
  const items = [
    item({ id: 'support-bot', name: 'Support bot', labels: ['billing'], enabled: true }),
    item({
      id: 'pr-reviewer',
      name: 'PR reviewer',
      labels: ['github', 'billing'],
      enabled: false,
      model: 'anthropic/claude-opus-5',
    }),
    item({ id: 'docs-qa', name: 'Docs QA', model: 'openai/gpt-5', enabled: true }),
  ];

  const ids = (filter: Parameters<typeof filterAgents>[1]) => filterAgents(items, filter).map((a) => a.id);

  it('matches q case-insensitively over name, id, description and model', () => {
    expect(ids({ q: 'GPT', labels: [], enabled: undefined })).toEqual(['docs-qa']);
    expect(ids({ q: 'support', labels: [], enabled: undefined })).toEqual(['support-bot']);
  });

  it('requires every selected label', () => {
    expect(ids({ q: '', labels: ['billing', 'github'], enabled: undefined })).toEqual(['pr-reviewer']);
    expect(ids({ q: '', labels: ['billing'], enabled: undefined })).toEqual(['pr-reviewer', 'support-bot']);
  });

  it('filters on enabled', () => {
    expect(ids({ q: '', labels: [], enabled: 'on' })).toEqual(['docs-qa', 'support-bot']);
    expect(ids({ q: '', labels: [], enabled: 'off' })).toEqual(['pr-reviewer']);
  });

  it('sorts by name case-insensitively, then id', () => {
    expect(ids({ q: '', labels: [], enabled: undefined })).toEqual(['docs-qa', 'pr-reviewer', 'support-bot']);
  });
});

describe('labelOptions', () => {
  it('lists every label sorted, with counts', () => {
    const items = [
      item({ id: 'a', labels: ['billing', 'GitHub'] }),
      item({ id: 'b', labels: ['billing'] }),
      item({ id: 'c', labels: [] }),
    ];
    expect(labelOptions(items)).toEqual([
      { value: 'billing', label: 'billing', count: 2 },
      { value: 'github', label: 'github', count: 1 },
    ]);
  });
});
