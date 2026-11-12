/**
 * Per-environment settings profiles.
 *
 * A profile is a small named bundle of "which provider, which stored key
 * reference, which deploy adapter, how long a sandboxed hook gets before
 * it's killed" - deliberately NOT a full multi-tenant config system. This
 * backs the Topbar's env indicator (the static "local · mock
 * provider" label becomes the active profile's name + provider) and the
 * Settings drawer's deploy-adapter dropdown/OTel toggle.
 *
 * Persisted to `.lousho/settings.json` (plaintext - it holds no secrets,
 * only a provider TYPE name like 'openai' and which of `secretsStore`'s
 * managed providers to use; the actual key lives only in
 * `secretsStore.ts`'s encrypted store). `.lousho/` is already gitignored.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { PassKind, PassSettings, PassSettingsPatch, SettingsFile, SettingsProfile } from '../shared/wireTypes';
import { PASS_KINDS } from '../shared/wireTypes';
import type { AuthorSettings } from '../shared/authorWire';
import type { StudioPaths } from './workspace/studioPaths';

const DEFAULT_PROFILES: SettingsProfile[] = [
  {
    id: 'local',
    name: 'local',
    providerType: 'mock',
    deployAdapter: 'node-server',
    otelEnabled: false,
    hookTimeoutMs: 5000,
    sandboxBackend: 'noop',
  },
  {
    id: 'staging',
    name: 'staging',
    providerType: 'openai',
    providerKeyRef: 'openai',
    deployAdapter: 'node-server',
    otelEnabled: false,
    hookTimeoutMs: 5000,
    sandboxBackend: 'noop',
  },
  {
    id: 'prod',
    name: 'prod',
    providerType: 'anthropic',
    providerKeyRef: 'anthropic',
    deployAdapter: 'docker',
    otelEnabled: true,
    hookTimeoutMs: 5000,
    sandboxBackend: 'noop',
  },
];

/** Every pass kind on by default (L06b). */
const DEFAULT_PASS_ENABLED: Record<PassKind, boolean> = Object.fromEntries(PASS_KINDS.map((kind) => [kind, true])) as Record<
  PassKind,
  boolean
>;

/** The background passes' out-of-the-box choices: a small fast model for everything, every kind on. */
const DEFAULT_PASS_SETTINGS: PassSettings = {
  model: 'anthropic/claude-haiku-5-5',
  autoApprovalModel: 'anthropic/claude-haiku-5-5',
  enabled: DEFAULT_PASS_ENABLED,
};

/** `model`/`autoApprovalModel` must look like `provider/model`. */
function assertModelField(field: 'model' | 'autoApprovalModel', value: unknown): void {
  if (value !== undefined && (typeof value !== 'string' || !/^[a-z0-9-]+\/\S+$/.test(value))) {
    throw new Error(`${field} must look like provider/model.`);
  }
}

/** `enabled` may name only known `PassKind`s with boolean values. */
function assertEnabledField(enabled: PassSettingsPatch['enabled']): void {
  if (enabled === undefined) return;
  if (typeof enabled !== 'object' || enabled === null || Array.isArray(enabled)) {
    throw new Error('enabled must be an object of pass kinds to booleans.');
  }
  for (const [kind, value] of Object.entries(enabled)) {
    if (!PASS_KINDS.includes(kind as PassKind) || typeof value !== 'boolean') {
      throw new Error(`enabled has an unknown pass kind or a non-boolean value: '${kind}'.`);
    }
  }
}

/** Throws the first `setPasses` validation failure, or nothing. */
function assertValidPassPatch(patch: PassSettingsPatch): void {
  assertModelField('model', patch.model);
  assertModelField('autoApprovalModel', patch.autoApprovalModel);
  assertEnabledField(patch.enabled);
}

function defaultFile(): SettingsFile {
  return { activeProfileId: DEFAULT_PROFILES[0].id, profiles: DEFAULT_PROFILES.map((p) => ({ ...p })) };
}

export class SettingsStore {
  private readonly file: string;

  /**
   * `location` is either the legacy base directory (the file lives at
   * `<baseDir>/.lousho/settings.json`) or the `settings` path of
   * `studioPaths()` (constructed once while wiring - handlers never
   * compute file locations themselves).
   */
  constructor(location: string | Pick<StudioPaths, 'settings'>) {
    this.file = typeof location === 'string' ? path.join(location, '.lousho', 'settings.json') : location.settings;
  }

  private ensureDir(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
  }

  load(): SettingsFile {
    if (!fs.existsSync(this.file)) return defaultFile();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!parsed || !Array.isArray(parsed.profiles) || parsed.profiles.length === 0) {
        return defaultFile();
      }
      return parsed as SettingsFile;
    } catch {
      return defaultFile();
    }
  }

  /**
   * Writes via `<file>.<8 hex>.tmp` + rename - the repo's atomic-write rule:
   * a reader polling settings.json only ever sees the old complete file or
   * the new one, never a torn write. `storage/atomic`'s async
   * `writeFileAtomic` isn't usable here because this store's API is
   * synchronous (the profile/author routes call it without `await`), so
   * this is the same scheme with `fs` sync calls.
   */
  private save(data: SettingsFile): void {
    this.ensureDir();
    const tmpPath = `${this.file}.${randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    try {
      fs.renameSync(tmpPath, this.file);
    } catch (error) {
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        // Best-effort cleanup: the rename error is what the caller needs.
      }
      throw error;
    }
  }

  /** All profiles + which id is active. */
  list(): SettingsFile {
    return this.load();
  }

  /** The currently-active profile (falls back to the first profile if the active id is somehow stale). */
  activeProfile(): SettingsProfile {
    const data = this.load();
    return data.profiles.find((p) => p.id === data.activeProfileId) ?? data.profiles[0];
  }

  /** Creates or replaces a profile by id. */
  upsertProfile(profile: SettingsProfile): SettingsFile {
    if (!profile.id || !profile.id.trim()) throw new Error('profile.id must be a non-empty string');
    const data = this.load();
    const idx = data.profiles.findIndex((p) => p.id === profile.id);
    if (idx >= 0) data.profiles[idx] = profile;
    else data.profiles.push(profile);
    this.save(data);
    return data;
  }

  /** Deletes a profile. Refuses to delete the last remaining one, and re-points `activeProfileId` if the active profile was removed. */
  removeProfile(id: string): SettingsFile {
    const data = this.load();
    if (data.profiles.length <= 1) {
      throw new Error('cannot remove the last remaining settings profile');
    }
    const next = data.profiles.filter((p) => p.id !== id);
    if (next.length === data.profiles.length) {
      throw new Error(`unknown profile '${id}'`);
    }
    const activeProfileId = data.activeProfileId === id ? next[0].id : data.activeProfileId;
    const result: SettingsFile = { activeProfileId, profiles: next };
    this.save(result);
    return result;
  }

  /** Switches which profile is active. */
  setActive(id: string): SettingsFile {
    const data = this.load();
    if (!data.profiles.some((p) => p.id === id)) {
      throw new Error(`unknown profile '${id}'`);
    }
    const result: SettingsFile = { ...data, activeProfileId: id };
    this.save(result);
    return result;
  }

  /** The stored Author settings patch (`{}` when none); `readAuthorSettings` merges the defaults under it. */
  getAuthor(): Partial<AuthorSettings> {
    return this.load().author ?? {};
  }

  /**
   * Merges `patch` into the stored `author` object, leaving the profiles
   * and every other settings.json key untouched. `undefined` values are
   * dropped so a sparse PUT body can't clear a field.
   */
  setAuthor(patch: Partial<AuthorSettings>): Partial<AuthorSettings> {
    const data = this.load();
    const clean = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    data.author = { ...data.author, ...clean };
    this.save(data);
    return data.author;
  }

  /**
   * The effective pass settings: the stored `passes` object merged over
   * {@link DEFAULT_PASS_SETTINGS}, `enabled` merged per kind so a stored
   * `{ prompt_suggestion: false }` keeps the other kinds on.
   */
  passes(): PassSettings {
    const stored = this.load().passes;
    return {
      model: stored?.model ?? DEFAULT_PASS_SETTINGS.model,
      autoApprovalModel: stored?.autoApprovalModel ?? DEFAULT_PASS_SETTINGS.autoApprovalModel,
      enabled: { ...DEFAULT_PASS_ENABLED, ...(stored?.enabled ?? {}) },
    };
  }

  /**
   * Validates `patch` and merges it into the stored `passes` object,
   * leaving the profiles and every other settings.json key untouched.
   * `model`/`autoApprovalModel` must look like `provider/model`; `enabled`
   * may name only known `PassKind`s with boolean values. Returns the
   * effective settings.
   */
  setPasses(patch: PassSettingsPatch): PassSettings {
    assertValidPassPatch(patch);
    const data = this.load();
    const stored: Partial<PassSettings> = data.passes ?? {};
    data.passes = {
      model: patch.model ?? stored.model ?? DEFAULT_PASS_SETTINGS.model,
      autoApprovalModel: patch.autoApprovalModel ?? stored.autoApprovalModel ?? DEFAULT_PASS_SETTINGS.autoApprovalModel,
      enabled: { ...DEFAULT_PASS_ENABLED, ...(stored.enabled ?? {}), ...(patch.enabled ?? {}) },
    };
    this.save(data);
    return this.passes();
  }
}
