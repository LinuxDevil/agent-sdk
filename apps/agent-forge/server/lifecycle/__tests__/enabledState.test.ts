import { describe, expect, it } from 'vitest';
import type { AgentMeta } from '../../../shared/wireTypes';
import { enabledPatch } from '../enabledState';

const NOW = '2026-11-12T00:00:00.000Z';

function meta(overrides: Partial<AgentMeta> = {}): AgentMeta {
  return {
    schemaVersion: 1,
    enabled: true,
    disabledAt: null,
    disabledReason: null,
    failureStreak: 0,
    labels: [],
    publishedVersion: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('enabledPatch', () => {
  it('disable when on stamps disabledAt and the reason', () => {
    expect(enabledPatch(meta(), false, 'manual', NOW)).toEqual({
      enabled: false,
      disabledAt: NOW,
      disabledReason: 'manual',
    });
    expect(enabledPatch(meta(), false, 'auto_failure_streak', NOW)).toEqual({
      enabled: false,
      disabledAt: NOW,
      disabledReason: 'auto_failure_streak',
    });
  });

  it('disable when already off is a no-op (keeps disabledAt/disabledReason)', () => {
    const off = meta({ enabled: false, disabledAt: '2026-01-02T00:00:00.000Z', disabledReason: 'auto_failure_streak' });
    expect(enabledPatch(off, false, 'manual', NOW)).toEqual({});
  });

  it('enable when off clears the disable fields and resets the failure streak', () => {
    const off = meta({ enabled: false, disabledAt: '2026-01-02T00:00:00.000Z', disabledReason: 'auto_failure_streak', failureStreak: 5 });
    expect(enabledPatch(off, true, 'manual', NOW)).toEqual({
      enabled: true,
      disabledAt: null,
      disabledReason: null,
      failureStreak: 0,
    });
  });

  it('enable when already on is a no-op', () => {
    expect(enabledPatch(meta(), true, 'manual', NOW)).toEqual({});
  });
});
