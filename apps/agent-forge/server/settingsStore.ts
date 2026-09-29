/**
 * LOU-R3: per-environment settings profiles.
 *
 * A profile is a small named bundle of "which provider, which stored key
 * reference, which deploy adapter, how long a sandboxed hook gets before
 * it's killed" - deliberately NOT a full multi-tenant config system. This
 * backs the Topbar's env indicator (LOU-L/O's static "local · mock
 * provider" label becomes the active profile's name + provider) and the
 * Settings drawer's deploy-adapter dropdown/OTel toggle.
 *
 * Persisted to `.loushy/settings.json` (plaintext - it holds no secrets,
 * only a provider TYPE name like 'openai' and which of `secretsStore`'s
 * managed providers to use; the actual key lives only in
 * `secretsStore.ts`'s encrypted store). `.loushy/` is already gitignored.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * LOU-Q's hardcoded 5s hook-sandbox timeout, now configurable per profile
 * (see hookSandbox.ts's `HookSandboxOptions.timeoutMs`). The sandbox
 * BACKEND stays NoopSandbox-only: `src/security/sandboxCore.ts` (the only
 * SandboxAdapter this SDK ships today) exports just `NoopSandbox` - there is
 * no second real adapter (e.g. a Docker-backed one) yet to offer a picker
 * over, so `sandboxBackend` here is a single-valued field reserved for when
 * one exists rather than a dropdown with one option pretending to be a choice.
 */
export interface SettingsProfile {
  id: string;
  name: string;
  /** Matches an `AgentSpec.provider.type` value ('mock' | 'openai' | 'anthropic' | 'ollama' | 'openrouter'). */
  providerType: string;
  /** Which `secretsStore` provider's stored key to use when `providerType` is one of `SECRET_PROVIDERS` ('openai' | 'anthropic'). `undefined` for 'mock'/'ollama'/'openrouter' (env-var/no-key providers). */
  providerKeyRef?: string;
  /** Deploy target name - see `src/deploy/index.ts`'s `registerBuiltInAdapters()` for the real registered names this must match. */
  deployAdapter: string;
  /** Opt-in bundled OTel export toggle (LOU-R's brief: ADDITIONALLY export to a real collector via `src/execution/otel.ts`'s `createOtelTraceExporter()`, not a replacement for LOU-O's own trace panel). */
  otelEnabled: boolean;
  /** Passed through to `hookSandbox.ts`'s `sandboxRunHook()` as `timeoutMs`. */
  hookTimeoutMs: number;
  sandboxBackend: 'noop';
}

export interface SettingsFile {
  activeProfileId: string;
  profiles: SettingsProfile[];
}

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

function defaultFile(): SettingsFile {
  return { activeProfileId: DEFAULT_PROFILES[0].id, profiles: DEFAULT_PROFILES.map((p) => ({ ...p })) };
}

export class SettingsStore {
  private readonly file: string;

  constructor(baseDir: string) {
    this.file = path.join(baseDir, '.loushy', 'settings.json');
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

  private save(data: SettingsFile): void {
    this.ensureDir();
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2), 'utf8');
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
}
