import { describe, expect, it } from 'vitest';

import type { AgentListItem } from '../../../../shared/wireTypes';
import { filterAgents, parseAgentListQuery, parseLabelsParam } from '../agentListUrl';

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

describe('parseLabelsParam', () => {
  it('normalises the comma-separated value and keeps selection order', () => {
    expect(parseLabelsParam('Billing Ops, support')).toEqual(['billing ops', 'support']);
    expect(parseLabelsParam('a,a, B ')).toEqual(['a', 'b']);
  });

  it('answers [] for absent or invalid input', () => {
    expect(parseLabelsParam(null)).toEqual([]);
    expect(parseLabelsParam('')).toEqual([]);
    expect(parseLabelsParam(`a,${'x'.repeat(40)}`)).toEqual([]);
  });
});

describe('parseAgentListQuery', () => {
  it('reads q, the comma-separated labels set and enabled', () => {
    expect(parseAgentListQuery(new URLSearchParams('q=Bot&labels=b,a&enabled=off'))).toEqual({
      q: 'Bot',
      labels: ['b', 'a'],
      enabled: 'off',
    });
  });

  it('drops an unknown enabled value, an invalid labels value and absent keys', () => {
    expect(parseAgentListQuery(new URLSearchParams(`enabled=maybe&labels=${'x'.repeat(40)}`))).toEqual({
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

  it('keeps agents carrying ANY selected label (OR)', () => {
    expect(ids({ q: '', labels: ['billing', 'github'], enabled: undefined })).toEqual(['pr-reviewer', 'support-bot']);
    expect(ids({ q: '', labels: ['github'], enabled: undefined })).toEqual(['pr-reviewer']);
    expect(ids({ q: '', labels: ['billing'], enabled: undefined })).toEqual(['pr-reviewer', 'support-bot']);
    expect(ids({ q: '', labels: ['missing'], enabled: undefined })).toEqual([]);
  });

  it('normalises both sides when matching labels', () => {
    const spaced = [item({ id: 'a', labels: ['Billing Ops'] })];
    expect(filterAgents(spaced, { q: '', labels: ['billing  ops'], enabled: undefined }).map((a) => a.id)).toEqual(['a']);
  });

  it('filters on enabled', () => {
    expect(ids({ q: '', labels: [], enabled: 'on' })).toEqual(['docs-qa', 'support-bot']);
    expect(ids({ q: '', labels: [], enabled: 'off' })).toEqual(['pr-reviewer']);
  });

  it('sorts by name case-insensitively, then id', () => {
    expect(ids({ q: '', labels: [], enabled: undefined })).toEqual(['docs-qa', 'pr-reviewer', 'support-bot']);
  });
});
