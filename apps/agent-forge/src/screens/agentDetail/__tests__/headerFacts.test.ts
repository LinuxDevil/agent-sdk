import { describe, expect, it } from 'vitest';

import type { AgentRecord } from '../../../../shared/wireTypes';
import { headerFacts } from '../AgentDetailHeader';

const NOW = Date.parse('2026-10-29T12:00:00Z');

function record(over: { spec?: Partial<AgentRecord['spec']>; updatedAt?: string } = {}): AgentRecord {
  return {
    id: 'support-bot',
    spec: {
      version: 2,
      name: 'Support bot',
      model: 'anthropic/claude-sonnet-5-5',
      instructions: 'Be helpful.',
      ...over.spec,
    },
    meta: {
      schemaVersion: 1,
      enabled: true,
      disabledAt: null,
      disabledReason: null,
      failureStreak: 0,
      labels: [],
      publishedVersion: null,
      createdAt: '2026-10-29T09:00:00Z',
      updatedAt: '2026-10-29T09:00:00Z',
    },
    layout: { schemaVersion: 1, nodes: {}, notes: [] },
    updatedAt: over.updatedAt ?? '2026-10-29T10:00:00Z',
    latestVersion: null,
    publishState: { version: null, matchesWorkingCopy: false, publishedAt: null },
  };
}

describe('headerFacts', () => {
  it('lists model, tool count, trigger count and update age in order', () => {
    const facts = headerFacts(
      record({
        spec: { tools: [{ builtin: 'web_search' }, { builtin: 'todo' }] },
        updatedAt: new Date(NOW - 2 * 3_600_000).toISOString(),
      }),
      NOW,
    ).map(({ label, value }) => ({ label, value }));
    expect(facts).toEqual([
      { label: 'Model', value: 'anthropic/claude-sonnet-5-5' },
      { label: 'Tools', value: '2 tools' },
      { label: 'Triggers', value: 'No triggers' },
      { label: 'Updated', value: 'Updated 2h ago' },
    ]);
  });

  it('singularises one tool/trigger and says so when there are none', () => {
    const facts = headerFacts(
      record({
        spec: {
          tools: [{ builtin: 'web_search' }],
          triggers: [{ id: 't1', type: 'chat' }],
        },
      }),
      NOW,
    ).map(({ label, value }) => ({ label, value }));
    expect(facts[1]).toEqual({ label: 'Tools', value: '1 tool' });
    expect(facts[2]).toEqual({ label: 'Triggers', value: '1 trigger' });
  });
});
