import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigurationError } from '../execution/errors';
import { loadImproveSettings } from './settings';

let dir: string;

const file = (value: unknown): void => writeFileSync(path.join(dir, 'improve.json'), typeof value === 'string' ? value : JSON.stringify(value));

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'lousho-settings-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadImproveSettings', () => {
  it('defaults to auto', () => {
    expect(loadImproveSettings(dir, {}, {})).toEqual({
      enabled: true,
      approval: 'auto',
      budget: { maxTokensPerDay: 2_000_000, maxCyclesPerDay: 4, maxAppliesPerDay: 1 },
      trigger: { minNewFailures: 3, requireRecurring: true },
      canary: { replayRuns: 6 },
      monitor: { minRuns: 20, window: 20, maxDrop: 0.05, autoRollback: true, giveUpDays: 7 },
      guard: { runs: 3, everyHours: 24, maxCases: 30 },
      cooldownHours: 24,
      rateLimit: { rpm: 20 },
      library: { enabled: true },
    });
  });

  it('env overrides the file and the flag overrides env', () => {
    file({ approval: 'auto' });
    expect(loadImproveSettings(dir, {}, {}).approval).toBe('auto');
    expect(loadImproveSettings(dir, {}, { LOUSHO_IMPROVE_APPROVAL: 'manual' }).approval).toBe('manual');
    expect(loadImproveSettings(dir, { approval: 'auto' }, { LOUSHO_IMPROVE_APPROVAL: 'manual' }).approval).toBe('auto');
  });

  it('rejects an unknown approval value', () => {
    expect(() => loadImproveSettings(dir, {}, { LOUSHO_IMPROVE_APPROVAL: 'yolo' })).toThrow(ConfigurationError);
    expect(() => loadImproveSettings(dir, { approval: 'sometimes' as 'auto' }, {})).toThrow(/--approval/);
    file({ approval: 'never' });
    expect(() => loadImproveSettings(dir, {}, {})).toThrow(/approval/);
  });

  it('rejects an unknown key, a bad value and broken JSON with LOUSHO_CONFIG_INVALID', () => {
    file({ budget: { maxAppliesPerDay: 1, perHour: 2 } });
    expect(() => loadImproveSettings(dir, {}, {})).toThrow(expect.objectContaining({ code: 'LOUSHO_CONFIG_INVALID' }));
    file({ monitor: { minRuns: 0 } });
    expect(() => loadImproveSettings(dir, {}, {})).toThrow(/monitor\.minRuns/);
    file({ canary: { traffic: { share: 0.5, sessions: 10 } } });
    expect(() => loadImproveSettings(dir, {}, {})).toThrow(/canary\.traffic\.share/);
    file('{ "approval": ');
    expect(() => loadImproveSettings(dir, {}, {})).toThrow(/not valid JSON/);
  });

  it('manual mode does not require recurring failures unless the file says so', () => {
    expect(loadImproveSettings(dir, { approval: 'manual' }, {}).trigger.requireRecurring).toBe(false);
    file({ trigger: { requireRecurring: true } });
    expect(loadImproveSettings(dir, { approval: 'manual' }, {}).trigger.requireRecurring).toBe(true);
  });

  it('reads every setting from the file', () => {
    const settings = {
      enabled: false,
      approval: 'manual',
      budget: { maxTokensPerCycle: 100, maxTokensPerDay: 1000, maxCyclesPerDay: 2, maxAppliesPerDay: 3 },
      trigger: { minNewFailures: 5, requireRecurring: false },
      canary: { replayRuns: 8, traffic: { share: 0.1, sessions: 10 } },
      monitor: { minRuns: 10, window: 15, maxDrop: 0.1, autoRollback: false, giveUpDays: 3 },
      guard: { runs: 2, everyHours: 12, maxCases: 40 },
      cooldownHours: 6,
      rateLimit: { rpm: 5 },
      library: { enabled: false, domain: 'billing' },
    };
    file({ $schema: './improve.schema.json', ...settings });
    expect(loadImproveSettings(dir, {}, {})).toEqual(settings);
  });

  it('ignores an empty LOUSHO_IMPROVE_APPROVAL', () => {
    expect(loadImproveSettings(dir, {}, { LOUSHO_IMPROVE_APPROVAL: '' }).approval).toBe('auto');
  });

  it('refuses fractional or zero counts, a maxDrop above 1 and an infinite number of hours', () => {
    for (const value of [{ budget: { maxCyclesPerDay: 1.5 } }, { guard: { runs: 0 } }, { monitor: { maxDrop: 1.5 } }, '{ "cooldownHours": 1e999 }']) {
      file(value);
      expect(() => loadImproveSettings(dir, {}, {})).toThrow(ConfigurationError);
    }
  });

  it('treats a missing file as the defaults', () => {
    expect(loadImproveSettings(path.join(dir, 'nowhere'), {}, {}).approval).toBe('auto');
  });
});
