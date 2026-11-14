import { describe, expect, it } from 'vitest';
import type { AgentSpecV2 } from '@linuxdevil/lousho/spec';

import type { Requirement } from '../../../../shared/wireTypes';
import { capabilityRows, missingRequirements, permissionRuleText, safetySummary, triggerLine } from '../overviewModel';

/** The ticket's overview spec fixture, completed to a valid `AgentSpecV2`. */
function spec(over: Partial<AgentSpecV2> = {}): AgentSpecV2 {
  return {
    version: 2,
    name: 'Support bot',
    model: 'anthropic/claude-sonnet-5-5',
    instructions: 'Be helpful.',
    tools: [{ builtin: 'http' }, { file: 'tools/lookup.ts' }, { id: 'gh', integration: 'github', credentials: {} }],
    mcpServers: { github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] } },
    skills: [{ dir: 'skills/tone' }],
    memory: [{ name: 'notes', scope: 'session', provider: { type: 'in-memory' } }],
    subagents: { researcher: { ref: 'agents/researcher.yaml' } },
    handoffs: [{ agent: 'billing' }],
    guardrails: [{ id: 'g1', name: 'pii', on: ['input', 'output'] }],
    permissions: [
      { id: 'p1', tool: 'github_*', action: 'ask' },
      { id: 'p2', tool: '*', action: 'ask' },
      { id: 'p3', tool: 'rm', action: 'deny' },
    ],
    limits: { maxCostUsd: 0.5 },
    maxSteps: 12,
    triggers: [
      { id: 't1', type: 'chat' },
      { id: 't2', type: 'cron', cron: '0 9 * * 1-5', timezone: 'UTC', prompt: 'x' },
      { id: 't3', type: 'webhook', path: '/gh', promptTemplate: 'x' },
      { id: 't4', type: 'channel', channel: 'github', secrets: {} },
      { id: 't5', type: 'agent', after: 'triage', on: 'done', promptTemplate: 'x' },
    ],
    ...over,
  } as AgentSpecV2;
}

describe('capabilityRows', () => {
  it('returns the six rows in order with the fixture items', () => {
    const rows = capabilityRows(spec());
    expect(rows.map((row) => row.label)).toEqual([
      'Tools',
      'MCP servers',
      'Skills',
      'Memory',
      'Subagents',
      'Handoffs',
    ]);
    expect(rows.map((row) => row.items)).toEqual([
      ['http', 'lookup.ts', 'gh'],
      ['github'],
      ['tone'],
      ['notes'],
      ['researcher'],
      ['billing'],
    ]);
  });

  it('treats absent sections as empty', () => {
    const rows = capabilityRows(spec({ tools: undefined, mcpServers: undefined, skills: undefined, memory: undefined, subagents: undefined, handoffs: undefined }));
    expect(rows.every((row) => row.items.length === 0)).toBe(true);
  });

  it('names registry, hosted, openapi and hub tools and inline skills', () => {
    const rows = capabilityRows(
      spec({
        tools: [{ registry: 'github-issues' }, { hosted: 'web_search' }, { openapi: { url: 'https://x.test/openapi.json' } }, { hub: true }],
        skills: [{ registry: 'changelog' }, { inline: { name: 'tone', description: 'd', content: 'c' } }],
      }),
    );
    expect(rows[0].items).toEqual(['github-issues', 'web_search', 'openapi', 'hub']);
    expect(rows[2].items).toEqual(['changelog', 'tone']);
  });
});

describe('triggerLine', () => {
  it('writes one line per trigger type', () => {
    const lines = spec().triggers!.map(triggerLine);
    expect(lines.map((line) => line.text)).toEqual([
      'Chat',
      'Cron · 0 9 * * 1-5 · UTC',
      'Webhook · /gh',
      'GitHub channel',
      'After triage · on done',
    ]);
  });

  it('omits the timezone when a cron trigger has none and prefixes a bare webhook path', () => {
    expect(triggerLine({ id: 'c', type: 'cron', cron: '*/5 * * * *', prompt: 'x' }).text).toBe('Cron · */5 * * * *');
    expect(triggerLine({ id: 'w', type: 'webhook', path: 'gh', promptTemplate: 'x' }).text).toBe('Webhook · /gh');
    expect(triggerLine({ id: 'ch', type: 'channel', channel: 'slack', secrets: {} }).text).toBe('Slack channel');
  });
});

describe('safetySummary', () => {
  it('rolls up guardrails, rule counts, mode and limits', () => {
    const summary = safetySummary(spec());
    expect(summary.guardrails).toEqual(['pii (both)']);
    expect(summary.rules).toEqual({ allow: 0, deny: 1, ask: 2, auto: 0 });
    expect(permissionRuleText(summary.rules)).toBe('1 deny · 2 ask');
    expect(summary.permissionMode).toBeUndefined();
    expect(summary.limits).toContain('Max steps 12');
    expect(summary.limits).toContain('Max cost $0.50');
  });

  it('renders a single-side guardrail and the permission mode', () => {
    const summary = safetySummary(
      spec({
        guardrails: [{ id: 'g2', name: 'secret-scan', on: 'tools' }],
        permissionMode: 'plan',
      }),
    );
    expect(summary.guardrails).toEqual(['secret-scan (tools)']);
    expect(summary.permissionMode).toBe('plan');
  });
});

describe('missingRequirements', () => {
  it('keeps only the missing rows', () => {
    const requirements: Requirement[] = [
      { id: 'a', kind: 'provider_key', status: 'ok', label: 'ok row' },
      { id: 'b', kind: 'secret', status: 'missing', label: 'A' },
      { id: 'c', kind: 'model', status: 'unknown', label: 'unknown row' },
    ];
    expect(missingRequirements(requirements).map((r) => r.label)).toEqual(['A']);
  });

  it('is empty when requirements are absent', () => {
    expect(missingRequirements(undefined)).toEqual([]);
  });
});
