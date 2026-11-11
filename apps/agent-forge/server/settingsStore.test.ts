import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SettingsStore } from './settingsStore';
import type { SettingsProfile } from '../shared/wireTypes';

describe('SettingsStore', () => {
  let baseDir: string;
  let store: SettingsStore;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-r-settings-'));
    store = new SettingsStore(baseDir);
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('seeds default local/staging/prod profiles with local active, before anything is saved', () => {
    const { activeProfileId, profiles } = store.list();
    expect(activeProfileId).toBe('local');
    expect(profiles.map((p) => p.id)).toEqual(['local', 'staging', 'prod']);
    expect(store.activeProfile().providerType).toBe('mock');
  });

  it('persists an upserted profile and reloads it from a fresh instance', () => {
    const profile: SettingsProfile = {
      id: 'local',
      name: 'local (edited)',
      providerType: 'openai',
      providerKeyRef: 'openai',
      deployAdapter: 'docker',
      otelEnabled: true,
      hookTimeoutMs: 9000,
      sandboxBackend: 'noop',
    };
    store.upsertProfile(profile);

    const restarted = new SettingsStore(baseDir);
    const reloaded = restarted.list().profiles.find((p) => p.id === 'local');
    expect(reloaded).toEqual(profile);
  });

  it('adds a brand-new profile id via upsert', () => {
    store.upsertProfile({
      id: 'custom',
      name: 'custom env',
      providerType: 'anthropic',
      deployAdapter: 'node-server',
      otelEnabled: false,
      hookTimeoutMs: 3000,
      sandboxBackend: 'noop',
    });
    expect(store.list().profiles.map((p) => p.id)).toContain('custom');
  });

  it('switches the active profile', () => {
    const result = store.setActive('staging');
    expect(result.activeProfileId).toBe('staging');
    expect(store.activeProfile().id).toBe('staging');
  });

  it('rejects activating an unknown profile id', () => {
    expect(() => store.setActive('nope')).toThrow(/unknown profile/);
  });

  it('removes a profile and re-points activeProfileId when the active one was removed', () => {
    store.setActive('staging');
    const result = store.removeProfile('staging');
    expect(result.profiles.map((p) => p.id)).not.toContain('staging');
    expect(result.activeProfileId).not.toBe('staging');
  });

  it('refuses to remove the last remaining profile', () => {
    store.removeProfile('staging');
    store.removeProfile('prod');
    expect(() => store.removeProfile('local')).toThrow(/last remaining/);
  });

  it('writes to the given file when constructed with a paths object instead of a baseDir', () => {
    const settings = path.join(baseDir, 'custom-home', 'settings.json');
    const fromPaths = new SettingsStore({ settings });
    fromPaths.setActive('staging');
    expect(fs.existsSync(settings)).toBe(true);
    expect(new SettingsStore({ settings }).list().activeProfileId).toBe('staging');
  });

  it('falls back to defaults if the settings file is corrupted', () => {
    fs.mkdirSync(path.join(baseDir, '.lousho'), { recursive: true });
    fs.writeFileSync(path.join(baseDir, '.lousho', 'settings.json'), 'not json', 'utf8');
    expect(() => store.list()).not.toThrow();
    expect(store.list().profiles.length).toBeGreaterThan(0);
  });

  describe('passes (L06b)', () => {
    it('answers the defaults on a fresh settings file', () => {
      expect(store.passes()).toEqual({
        model: 'anthropic/claude-haiku-5-5',
        autoApprovalModel: 'anthropic/claude-haiku-5-5',
        enabled: {
          version_summary: true,
          draft_review: true,
          portability_check: true,
          prompt_suggestion: true,
          auto_approval: true,
          eval_judge: true,
        },
      });
    });

    it('merges a patch over the stored values and keeps the profiles untouched', () => {
      store.setActive('staging');
      const merged = store.setPasses({ model: 'openai/gpt-4o-mini', enabled: { prompt_suggestion: false } });
      expect(merged.model).toBe('openai/gpt-4o-mini');
      expect(merged.autoApprovalModel).toBe('anthropic/claude-haiku-5-5');
      expect(merged.enabled.prompt_suggestion).toBe(false);
      expect(merged.enabled.eval_judge).toBe(true);
      expect(store.list().activeProfileId).toBe('staging');
      // A fresh instance reads the same merged settings back.
      expect(new SettingsStore(baseDir).passes()).toEqual(merged);
    });

    it('rejects a model without provider/ and an unknown or non-boolean enabled kind', () => {
      expect(() => store.setPasses({ model: 'haiku' })).toThrow(/provider\/model/);
      expect(() => store.setPasses({ autoApprovalModel: 'x' })).toThrow(/provider\/model/);
      expect(() => store.setPasses({ enabled: { foo: true } as never })).toThrow(/unknown pass kind/);
      expect(() => store.setPasses({ enabled: { eval_judge: 'yes' } as never })).toThrow(/unknown pass kind|non-boolean/);
    });
  });
});
