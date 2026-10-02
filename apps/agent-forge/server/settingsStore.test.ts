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

  it('falls back to defaults if the settings file is corrupted', () => {
    fs.mkdirSync(path.join(baseDir, '.lousho'), { recursive: true });
    fs.writeFileSync(path.join(baseDir, '.lousho', 'settings.json'), 'not json', 'utf8');
    expect(() => store.list()).not.toThrow();
    expect(store.list().profiles.length).toBeGreaterThan(0);
  });
});
