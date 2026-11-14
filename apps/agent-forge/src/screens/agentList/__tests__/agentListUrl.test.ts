import { describe, expect, it } from 'vitest';

import type { WorkspaceAgentItem, WorkspaceListItem } from '../../../../shared/wireTypes';
import { filterAgents, parseAgentListQuery, parseLabelsParam, workspaceOptions } from '../agentListUrl';

const item = (over: Partial<WorkspaceAgentItem>): WorkspaceAgentItem => ({
  id: 'agent',
  name: 'Agent',
  description: '',
  model: 'anthropic/claude-sonnet-5-5',
  enabled: true,
  labels: [],
  updatedAt: '2026-10-29T11:00:00Z',
  publishedVersion: null,
  counts: { tools: 0, mcpServers: 0, subagents: 0, triggers: 0 },
  kind: 'workspace',
  workspaceId: 'ws-a',
  ...over,
});

const ws = (id: string, name: string): WorkspaceListItem => ({
  id,
  name,
  root: `/tmp/${name}`,
  addedAt: '2026-01-01T00:00:00Z',
  lastOpenedAt: '2026-01-01T00:00:00Z',
  isLaunch: false,
  available: true,
  agentCount: 0,
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
  it('reads q, the comma-separated labels set, enabled and workspaces', () => {
    expect(parseAgentListQuery(new URLSearchParams('q=Bot&labels=b,a&enabled=off&workspace=ws-a,ws-b'))).toEqual({
      q: 'Bot',
      labels: ['b', 'a'],
      enabled: 'off',
      workspaces: ['ws-a', 'ws-b'],
    });
  });

  it('drops an unknown enabled value, an invalid labels value and absent keys', () => {
    expect(parseAgentListQuery(new URLSearchParams(`enabled=maybe&labels=${'x'.repeat(40)}`))).toEqual({
      q: '',
      labels: [],
      enabled: undefined,
      workspaces: [],
    });
    expect(parseAgentListQuery(new URLSearchParams())).toEqual({ q: '', labels: [], enabled: undefined, workspaces: [] });
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
    item({ id: 'support-bot', name: 'Support bot B', workspaceId: 'ws-b', labels: ['billing'] }),
  ];

  const ids = (filter: Parameters<typeof filterAgents>[1]) => filterAgents(items, filter).map((a) => `${a.workspaceId}/${a.id}`);

  it('matches q case-insensitively over name, id, description and model', () => {
    expect(ids({ q: 'GPT', labels: [], enabled: undefined, workspaces: [] })).toEqual(['ws-a/docs-qa']);
    expect(ids({ q: 'support', labels: [], enabled: undefined, workspaces: [] })).toEqual(['ws-a/support-bot', 'ws-b/support-bot']);
  });

  it('keeps agents carrying ANY selected label (OR)', () => {
    expect(ids({ q: '', labels: ['billing', 'github'], enabled: undefined, workspaces: [] })).toEqual([
      'ws-a/pr-reviewer',
      'ws-a/support-bot',
      'ws-b/support-bot',
    ]);
    expect(ids({ q: '', labels: ['github'], enabled: undefined, workspaces: [] })).toEqual(['ws-a/pr-reviewer']);
    expect(ids({ q: '', labels: ['billing'], enabled: undefined, workspaces: [] })).toEqual(['ws-a/pr-reviewer', 'ws-a/support-bot', 'ws-b/support-bot']);
    expect(ids({ q: '', labels: ['missing'], enabled: undefined, workspaces: [] })).toEqual([]);
  });

  it('normalises both sides when matching labels', () => {
    const spaced = [item({ id: 'a', labels: ['Billing Ops'] })];
    expect(filterAgents(spaced, { q: '', labels: ['billing  ops'], enabled: undefined, workspaces: [] }).map((a) => a.id)).toEqual(['a']);
  });

  it('filters on enabled', () => {
    expect(ids({ q: '', labels: [], enabled: 'on', workspaces: [] })).toEqual(['ws-a/docs-qa', 'ws-a/support-bot', 'ws-b/support-bot']);
    expect(ids({ q: '', labels: [], enabled: 'off', workspaces: [] })).toEqual(['ws-a/pr-reviewer']);
  });

  it('filters on workspaces when the selection is non-empty (W06b)', () => {
    expect(ids({ q: '', labels: [], enabled: undefined, workspaces: ['ws-b'] })).toEqual(['ws-b/support-bot']);
    expect(ids({ q: '', labels: [], enabled: undefined, workspaces: ['ws-a', 'ws-b'] })).toHaveLength(4);
    expect(ids({ q: '', labels: [], enabled: undefined, workspaces: ['ws-missing'] })).toEqual([]);
  });

  it('sorts by name case-insensitively, then id, then workspaceId', () => {
    expect(ids({ q: '', labels: [], enabled: undefined, workspaces: [] })).toEqual([
      'ws-a/docs-qa',
      'ws-a/pr-reviewer',
      'ws-a/support-bot',
      'ws-b/support-bot',
    ]);
  });
});

describe('workspaceOptions', () => {
  it('labels from the workspace list, counts from the items, sorted by label', () => {
    const items = [
      item({ id: 'a1', workspaceId: 'ws-b' }),
      item({ id: 'a2', workspaceId: 'ws-b' }),
      item({ id: 'a3', workspaceId: 'ws-a' }),
    ];
    const list = [ws('ws-a', 'Alpha'), ws('ws-b', 'Beta'), ws('ws-c', 'Gamma')];
    expect(workspaceOptions(items, list)).toEqual([
      { value: 'ws-a', label: 'Alpha', count: 1 },
      { value: 'ws-b', label: 'Beta', count: 2 },
      { value: 'ws-c', label: 'Gamma', count: 0 },
    ]);
  });

  it('falls back to the id as label and works without the list', () => {
    const items = [item({ id: 'a1', workspaceId: 'ws-x' })];
    expect(workspaceOptions(items, undefined)).toEqual([{ value: 'ws-x', label: 'ws-x', count: 1 }]);
  });
});
