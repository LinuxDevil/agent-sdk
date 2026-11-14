import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { WorkspaceRef } from '../../../shared/workspace';
import { SecretsStore } from '../../secretsStore';
import { SettingsStore } from '../../settingsStore';
import { studioPathsFor } from '../studioPaths';
import { LegacyImportService } from '../legacyImport';

/**
 * W03a's one-time import (server/workspace/legacyImport.ts): detection of
 * a workspace's old project-level `.lousho/` settings/secrets, copy-only-
 * what-is-missing rules, the `legacy-imports.json` outcome records, and
 * the guarantee the old files are never touched.
 */

let dir: string;
let homeDir: string;
let workspaceDir: string;
let paths: ReturnType<typeof studioPathsFor>;
let settings: SettingsStore;
let secrets: SecretsStore;
let service: LegacyImportService;
let ref: WorkspaceRef;

const PROD_PROFILE = {
  id: 'legacy-acme',
  name: 'legacy-acme',
  providerType: 'openai',
  providerKeyRef: 'openai',
  deployAdapter: 'node-server',
  otelEnabled: false,
  hookTimeoutMs: 5000,
  sandboxBackend: 'noop' as const,
};

function legacySettings(): SettingsStore {
  return new SettingsStore(workspaceDir);
}

function legacySecrets(): SecretsStore {
  return new SecretsStore(workspaceDir);
}

function writeOldSettings(): void {
  const store = legacySettings();
  store.upsertProfile(PROD_PROFILE);
  store.setActive('legacy-acme');
}

function writeOldSecrets(): void {
  const store = legacySecrets();
  store.setKey('openai', 'sk-old-openai-key');
  store.setSecret('GITHUB_TOKEN', 'ghp_old_token');
}

function snapshot(dirPath: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.set(full, fs.readFileSync(full, 'utf8'));
    }
  };
  walk(dirPath);
  return files;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w03a-import-'));
  homeDir = path.join(dir, 'home');
  workspaceDir = path.join(dir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  paths = studioPathsFor(homeDir);
  settings = new SettingsStore(paths);
  secrets = new SecretsStore(paths);
  service = new LegacyImportService({ file: paths.legacyImports, settings, secrets, home: paths });
  ref = { id: 'ws-abc123', name: 'workspace', root: workspaceDir, addedAt: '', lastOpenedAt: '' };
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('status detection', () => {
  it('a workspace with nothing old offers nothing', async () => {
    expect(await service.status(ref)).toEqual({ workspaceId: ref.id, found: [], handled: null });
  });

  it('settings.json alone is found', async () => {
    writeOldSettings();
    expect((await service.status(ref)).found).toEqual(['settings']);
  });

  it('secrets.json without secrets.key is NOT found (ciphertext cannot cross keys)', async () => {
    fs.mkdirSync(path.join(workspaceDir, '.lousho'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, '.lousho', 'secrets.json'), '{"openai":{"iv":"x"}}');
    expect((await service.status(ref)).found).toEqual([]);
  });

  it('settings.json + secrets.json + secrets.key are both found', async () => {
    writeOldSettings();
    writeOldSecrets();
    expect((await service.status(ref)).found).toEqual(['settings', 'secrets']);
  });

  it('a pre-W03 install whose .lousho IS the home offers nothing', async () => {
    // LOUSHO_STUDIO_HOME=<root>/.lousho: the "old" files are the home's own.
    const oldHome = path.join(workspaceDir, '.lousho');
    fs.mkdirSync(oldHome, { recursive: true });
    const oldPaths = studioPathsFor(oldHome);
    const oldSettings = new SettingsStore(oldPaths);
    oldSettings.upsertProfile(PROD_PROFILE);
    const oldSecrets = new SecretsStore(oldPaths);
    oldSecrets.setKey('openai', 'sk-same');
    const sameService = new LegacyImportService({
      file: oldPaths.legacyImports,
      settings: oldSettings,
      secrets: oldSecrets,
      home: oldPaths,
    });
    expect((await sameService.status(ref)).found).toEqual([]);
  });
});

describe('importFrom', () => {
  it('copies profiles, provider keys and named secrets; records imported; originals untouched', async () => {
    writeOldSettings();
    writeOldSecrets();
    const before = snapshot(path.join(workspaceDir, '.lousho'));

    const result = await service.importFrom(ref);
    expect(result).toEqual({ profiles: 1, providerKeys: 1, namedSecrets: 1 });

    // The new home serves the same values.
    expect(settings.list().profiles.map((p) => p.id)).toContain('legacy-acme');
    expect(settings.activeProfile().id).toBe('legacy-acme'); // home had no settings.json -> old active wins
    expect(secrets.getKey('openai')).toBe('sk-old-openai-key');
    expect(secrets.getSecret('GITHUB_TOKEN')).toBe('ghp_old_token');

    // The old files are byte-identical.
    const after = snapshot(path.join(workspaceDir, '.lousho'));
    expect(after).toEqual(before);

    // The outcome is recorded; a second status reports 'imported'.
    expect((await service.status(ref)).handled).toBe('imported');
    const record = JSON.parse(fs.readFileSync(paths.legacyImports, 'utf8'));
    expect(record).toMatchObject({ schemaVersion: 1, workspaces: { [ref.id]: { outcome: 'imported' } } });
  });

  it('never overwrites a value the home already has', async () => {
    writeOldSecrets();
    secrets.setKey('openai', 'sk-NEW-home-key'); // home already has one
    const result = await service.importFrom(ref);
    expect(result).toEqual({ profiles: 0, providerKeys: 0, namedSecrets: 1 });
    expect(secrets.getKey('openai')).toBe('sk-NEW-home-key');
    expect(secrets.getSecret('GITHUB_TOKEN')).toBe('ghp_old_token');
  });

  it('keeps the home activeProfileId when the home already had settings.json', async () => {
    writeOldSettings();
    settings.upsertProfile({ ...PROD_PROFILE, id: 'home-only' }); // creates the home's file
    settings.setActive('local');
    await service.importFrom(ref);
    expect(settings.activeProfile().id).toBe('local');
    expect(settings.list().profiles.map((p) => p.id)).toContain('legacy-acme');
  });

  it('skip records skipped without copying anything', async () => {
    writeOldSettings();
    await service.skip(ref);
    expect((await service.status(ref)).handled).toBe('skipped');
    expect(settings.list().profiles.map((p) => p.id)).not.toContain('legacy-acme');
  });
});
