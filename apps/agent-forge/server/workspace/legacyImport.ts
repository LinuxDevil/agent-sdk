/**
 * One-time import of a workspace's old project-level global state into
 * the Studio home (W03a; PLAN §19.2's "Import settings and keys from
 * <workspace>").
 *
 * Before W03a every Studio-global store lived at `<workspace>/.lousho/`;
 * now they live in the Studio home (`~/.lousho/studio`). A registered
 * workspace that still has `settings.json`/`secrets.json` there can copy
 * them in once - this service detects what is missing, copies only what
 * the home does not already have (existing values are NEVER overwritten),
 * and records the outcome in `legacy-imports.json` so the offer is made
 * once. The old files are only ever read, never written.
 *
 * `secrets` is only offered when BOTH `secrets.json` and `secrets.key`
 * exist under the old `.lousho/` - the key is the only way to decrypt
 * the old ciphertext, and copying it across keys would produce garbage.
 * It is also not offered when the old paths ARE the home's files (a
 * pre-W03 install that ran with `LOUSHO_STUDIO_HOME=<root>/.lousho`
 * has nothing to import).
 */
import { promises as fsPromises } from 'node:fs';
import * as path from 'node:path';
import type { LegacyImportItem, LegacyImportResult, LegacyImportStatus } from '../../shared/wireTypes';
import type { WorkspaceRef } from '../../shared/workspace';
import { readJsonFile, writeJsonAtomic } from '../storage/atomic';
import { SecretsStore } from '../secretsStore';
import { SettingsStore } from '../settingsStore';
import type { StudioPaths } from './studioPaths';

/** The `legacy-imports.json` document: one outcome record per workspace id. */
interface LegacyImportsFile {
  schemaVersion: 1;
  workspaces: Record<string, { outcome: 'imported' | 'skipped'; at: string }>;
}

export interface LegacyImportDeps {
  /** `studioPaths().legacyImports`. */
  file: string;
  /** The app's settings store (the new home's). */
  settings: SettingsStore;
  /** The app's secrets store (the new home's). */
  secrets: SecretsStore;
  /** The home's own file locations - a legacy path equal to one of these is the home itself, not an import source. */
  home: Pick<StudioPaths, 'settings' | 'secrets' | 'secretsKey'>;
  now?: () => Date;
}

export class LegacyImportService {
  private readonly now: () => Date;

  constructor(private readonly deps: LegacyImportDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** What the workspace's old `.lousho/` still offers, plus its handled state (`null` while it can still be offered). */
  async status(ref: WorkspaceRef): Promise<LegacyImportStatus> {
    const [found, record] = await Promise.all([this.found(ref), this.record(ref.id)]);
    return { workspaceId: ref.id, found, handled: record?.outcome ?? null };
  }

  /**
   * Copies every found item into the home, never overwriting what is
   * already there, then records 'imported'. Callers answer 409 first when
   * `found` is empty (`status().found.length === 0`).
   */
  async importFrom(ref: WorkspaceRef): Promise<LegacyImportResult> {
    const result: LegacyImportResult = { profiles: 0, providerKeys: 0, namedSecrets: 0 };
    const found = await this.found(ref);
    if (found.includes('settings')) result.profiles = await this.importProfiles(ref);
    if (found.includes('secrets')) {
      const secrets = await this.importSecrets(ref);
      result.providerKeys = secrets.providerKeys;
      result.namedSecrets = secrets.namedSecrets;
    }
    await this.mark(ref.id, 'imported');
    return result;
  }

  /** Records 'skipped' - the banner offer is dismissed for this workspace. */
  async skip(ref: WorkspaceRef): Promise<void> {
    await this.mark(ref.id, 'skipped');
  }

  /** The old `.lousho/` files that exist and are not the home's own files. */
  private async found(ref: WorkspaceRef): Promise<LegacyImportItem[]> {
    const dir = path.join(ref.root, '.lousho');
    const found: LegacyImportItem[] = [];
    const settingsFile = path.join(dir, 'settings.json');
    if ((await isFile(settingsFile)) && !samePath(settingsFile, this.deps.home.settings)) found.push('settings');
    const secretsFile = path.join(dir, 'secrets.json');
    const secretsKey = path.join(dir, 'secrets.key');
    if (
      (await isFile(secretsFile)) &&
      (await isFile(secretsKey)) &&
      !samePath(secretsFile, this.deps.home.secrets) &&
      !samePath(secretsKey, this.deps.home.secretsKey)
    ) {
      found.push('secrets');
    }
    return found;
  }

  /**
   * Every old profile whose id the home lacks is added. `activeProfileId`
   * follows the old file only when the home had no `settings.json` at all
   * before the import (an existing home's choice is never overridden).
   */
  private async importProfiles(ref: WorkspaceRef): Promise<number> {
    const homeHadFile = await isFile(this.deps.home.settings);
    const old = new SettingsStore(ref.root).list();
    const settings = this.deps.settings;
    const known = new Set(settings.list().profiles.map((profile) => profile.id));
    let copied = 0;
    for (const profile of old.profiles) {
      if (known.has(profile.id)) continue;
      settings.upsertProfile(profile);
      known.add(profile.id);
      copied += 1;
    }
    if (!homeHadFile && known.has(old.activeProfileId)) settings.setActive(old.activeProfileId);
    return copied;
  }

  /** Provider keys and named secrets the home lacks; values are copied store-to-store and never logged or returned. */
  private async importSecrets(ref: WorkspaceRef): Promise<{ providerKeys: number; namedSecrets: number }> {
    const old = new SecretsStore(ref.root);
    const secrets = this.deps.secrets;
    let providerKeys = 0;
    let namedSecrets = 0;
    for (const status of old.list()) {
      if (!status.hasKey) continue;
      const key = old.getKey(status.provider);
      if (key !== undefined && secrets.getKey(status.provider) === undefined) {
        secrets.setKey(status.provider, key);
        providerKeys += 1;
      }
    }
    for (const status of old.listSecrets()) {
      if (!status.hasValue) continue;
      const value = old.getSecret(status.name);
      if (value !== undefined && secrets.getSecret(status.name) === undefined) {
        secrets.setSecret(status.name, value);
        namedSecrets += 1;
      }
    }
    return { providerKeys, namedSecrets };
  }

  private async record(id: string): Promise<LegacyImportsFile['workspaces'][string] | undefined> {
    const doc = await readJsonFile<LegacyImportsFile>(this.deps.file);
    return doc?.workspaces?.[id];
  }

  private async mark(id: string, outcome: 'imported' | 'skipped'): Promise<void> {
    const doc = (await readJsonFile<LegacyImportsFile>(this.deps.file)) ?? { schemaVersion: 1 as const, workspaces: {} };
    doc.workspaces[id] = { outcome, at: this.now().toISOString() };
    await writeJsonAtomic(this.deps.file, doc);
  }
}

async function isFile(file: string): Promise<boolean> {
  const stat = await fsPromises.stat(file).catch(() => undefined);
  return stat?.isFile() === true;
}

/** `path.resolve` on both sides so Windows drive-letter/case and `..` segments compare equal (the ticket's gotcha). */
function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}
