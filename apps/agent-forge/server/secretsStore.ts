/**
 * Local, encrypted-at-rest storage for provider API keys.
 *
 * Design and why:
 *  - Keys are NEVER written into an `AgentSpec` (the YAML this app's
 *    `fsAgentStore.ts` persists under `.lousho/agents/<id>.yaml`, which a
 *    user may reasonably commit to source control alongside the rest of
 *    their agent's definition). They live in a completely separate file,
 *    `.lousho/secrets.json`, that this app never writes an `AgentSpec` into.
 *  - `.lousho/` is already listed in the repo root `.gitignore` (added for
 *    the checkpoints/approvals/saved-agent-spec local state) - verified
 *    as part of this ticket rather than assumed, since an ungitignored
 *    secrets file would be the actual security bug this ticket is guarding
 *    against.
 *  - At rest, each key is encrypted with AES-256-GCM under a random 256-bit
 *    key generated on first use and stored alongside it, in
 *    `.lousho/secrets.key` (both files written with `0o600` permissions on
 *    POSIX; best-effort on Windows, where POSIX mode bits are not
 *    meaningful - see the try/catch around chmod below).
 *
 *    Tradeoff, stated plainly: because the encryption key lives on the same
 *    local disk as the ciphertext (not in an OS keychain / HSM), this does
 *    NOT protect a secret from an attacker who already has full read access
 *    to this machine's filesystem as this user - which is also true of every
 *    other piece of local state this app already keeps unencrypted
 *    (checkpoints, approvals, chat transcripts). What it DOES protect
 *    against, which plaintext-in-`secrets.json` would not:
 *      1. `.lousho/secrets.json` "looking like a safe plaintext config file"
 *         and accidentally being included by some OTHER tool that doesn't
 *         respect .gitignore - a backup script, a screen share of the repo
 *         tree, a support bundle, a `zip -r` of the project directory, etc.
 *         A ciphertext blob is not directly usable without also grabbing
 *         `secrets.key` from a second, separately-named file.
 *      2. A key ending up readable in the one place (`AgentSpec` YAML) this
 *         app actively encourages committing/sharing.
 *    A real OS keychain (via `keytar` or similar) would close the first gap
 *    more thoroughly, but pulls in a native dependency (per-platform
 *    prebuilds, extra install complexity) for a local dev tool where the
 *    threat model above is "don't leak keys through gitignore-blind tooling
 *    or the app's own file-sharing feature", not "resist a fully compromised
 *    host". That didn't clear the bar to justify the added complexity here;
 *    revisit if this app ever needs to defend a shared/multi-user host.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProviderKeyStatus, SecretStatus } from '../shared/wireTypes';
import type { StudioPaths } from './workspace/studioPaths';

/** Providers this app manages stored keys for - matches `src/providers/` real (non-mock) provider types that take a plain API key (not `ollama`, which uses a base URL instead - see `PROVIDER_ENV_TABLE` in `src/providers/resolveProvider.ts`). */
const SECRET_PROVIDERS = ['openai', 'anthropic'] as const;
export type SecretProvider = (typeof SECRET_PROVIDERS)[number];

/** The env var each managed provider falls back to when no key is stored (buildAgent.ts resolves runs with it; `list()` reports whether it is set). */
export const PROVIDER_KEY_ENV: Record<SecretProvider, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

export function isSecretProvider(value: string): value is SecretProvider {
  return (SECRET_PROVIDERS as readonly string[]).includes(value);
}

/**
 * A named secret's name is env-var-like: a letter or underscore first,
 * then letters, digits and underscores, at most 64 chars - the same
 * charset a spec author would use for the `{ env }` form, so a stored
 * `GITHUB_TOKEN` reads naturally next to `{ env: 'GITHUB_TOKEN' }`.
 */
export const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** The largest secret value the store accepts (16 KiB of UTF-8 text). */
export const MAX_SECRET_VALUE_LENGTH = 16_384;

interface EncryptedRecord {
  iv: string;
  tag: string;
  ciphertext: string;
}

/**
 * The on-disk shape of `secrets.json`: the two provider-key records at
 * top level (unchanged since the file was introduced) plus `named`, a
 * map of named-secret records each stamped with the `updatedAt`
 * `SecretStatus` reports. Older files without `named` read as `{}`.
 */
type SecretsFile = Partial<Record<SecretProvider, EncryptedRecord>> & {
  named?: Record<string, EncryptedRecord & { updatedAt: string }>;
};

/** `••••••••<last 4>` (or all-dots for a key too short to safely reveal 4 chars of). Never called with, or able to leak, more than the last 4 characters. */
export function maskKey(key: string): string {
  if (key.length <= 4) return '••••';
  return `••••••••${key.slice(-4)}`;
}

export class SecretsStore {
  private readonly dir: string;
  private readonly keyFile: string;
  private readonly secretsFile: string;

  /**
   * `location` is either the legacy base directory (the files live at
   * `<baseDir>/.lousho/secrets.{json,key}`) or the `secrets`/`secretsKey`
   * paths of `studioPaths()` (constructed once while wiring - handlers
   * never compute file locations themselves).
   */
  constructor(location: string | Pick<StudioPaths, 'secrets' | 'secretsKey'>) {
    if (typeof location === 'string') {
      this.dir = path.join(location, '.lousho');
      this.keyFile = path.join(this.dir, 'secrets.key');
      this.secretsFile = path.join(this.dir, 'secrets.json');
    } else {
      this.secretsFile = location.secrets;
      this.keyFile = location.secretsKey;
      this.dir = path.dirname(this.secretsFile);
    }
  }

  private ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private chmodBestEffort(file: string): void {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Not meaningful on Windows / some filesystems - the encryption is
      // the real protection layer here, this is defense in depth only.
    }
  }

  private loadOrCreateEncryptionKey(): Buffer {
    this.ensureDir();
    if (fs.existsSync(this.keyFile)) {
      return Buffer.from(fs.readFileSync(this.keyFile, 'utf8').trim(), 'base64');
    }
    const key = crypto.randomBytes(32);
    fs.writeFileSync(this.keyFile, key.toString('base64'), 'utf8');
    this.chmodBestEffort(this.keyFile);
    return key;
  }

  private loadRecords(): SecretsFile {
    if (!fs.existsSync(this.secretsFile)) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(this.secretsFile, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private saveRecords(records: SecretsFile): void {
    this.ensureDir();
    fs.writeFileSync(this.secretsFile, JSON.stringify(records, null, 2), 'utf8');
    this.chmodBestEffort(this.secretsFile);
  }

  /** AES-256-GCM under the store's key, fresh IV per call - the one encryption path provider keys and named secrets share. */
  private encrypt(value: string): EncryptedRecord {
    const encryptionKey = this.loadOrCreateEncryptionKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  /**
   * The plaintext behind `record`, or `undefined` when it fails to
   * decrypt (a hand-edited/corrupted file, or a different secrets.key) -
   * callers treat that the same as "no value stored".
   */
  private decrypt(record: EncryptedRecord): string | undefined {
    try {
      const encryptionKey = this.loadOrCreateEncryptionKey();
      const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(record.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, 'base64')),
        decipher.final(),
      ]);
      return plaintext.toString('utf8');
    } catch {
      return undefined;
    }
  }

  /** Encrypts and stores `apiKey` for `provider`, replacing any existing key. */
  setKey(provider: SecretProvider, apiKey: string): void {
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      throw new Error('apiKey must be a non-empty string');
    }
    const records = this.loadRecords();
    records[provider] = this.encrypt(apiKey);
    this.saveRecords(records);
  }

  /** Removes any stored key for `provider`. No-ops if none is stored. */
  removeKey(provider: SecretProvider): void {
    const records = this.loadRecords();
    if (provider in records) {
      delete records[provider];
      this.saveRecords(records);
    }
  }

  /**
   * Decrypts and returns the real key for `provider`, or `undefined` if
   * none is stored (or it fails to decrypt, e.g. a hand-edited/corrupted
   * file). Server-internal only - route handlers must NEVER put this
   * return value into a response body; use `list()`/`maskKey()` instead.
   */
  getKey(provider: SecretProvider): string | undefined {
    const record = this.loadRecords()[provider];
    if (!record) return undefined;
    return this.decrypt(record);
  }

  /** Masked status for every managed provider, plus whether its env var is set (never its value) - safe to return from a GET route. */
  list(): ProviderKeyStatus[] {
    const records = this.loadRecords();
    return SECRET_PROVIDERS.map((provider) => {
      const hasKey = provider in records;
      const key = hasKey ? this.getKey(provider) : undefined;
      return { provider, hasKey: hasKey && !!key, masked: key ? maskKey(key) : null, envKey: !!process.env[PROVIDER_KEY_ENV[provider]] };
    });
  }

  // -------------------------------------------------------------------
  // Named secrets: `secrets.json`'s `named` map. These are the values a
  // spec's `{ secret: '<name>' }` refs resolve to (the run host calls
  // `getSecret` as its `resolveSecret`) - arbitrary secrets like
  // GITHUB_TOKEN or SLACK_BOT_TOKEN, kept under the same encryption as
  // the provider keys but listed/managed separately so `/settings/providers`
  // is unchanged.
  // -------------------------------------------------------------------

  /**
   * Encrypts and stores `value` under `name`, replacing any existing
   * secret, and returns its masked status. Throws on a name that fails
   * `SECRET_NAME_RE` or a value that isn't a 1..MAX_SECRET_VALUE_LENGTH
   * string of non-whitespace - the route maps those to 400s; the errors
   * name the secret, never the value.
   */
  setSecret(name: string, value: string): SecretStatus {
    if (!SECRET_NAME_RE.test(name)) {
      throw new Error(`Invalid secret name '${name}'`);
    }
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SECRET_VALUE_LENGTH || !value.trim()) {
      throw new Error(`Invalid value for secret '${name}'`);
    }
    const updatedAt = new Date().toISOString();
    const records = this.loadRecords();
    records.named = { ...records.named, [name]: { ...this.encrypt(value), updatedAt } };
    this.saveRecords(records);
    return { name, hasValue: true, masked: maskKey(value), updatedAt };
  }

  /**
   * Decrypts and returns the real value stored under `name`, or
   * `undefined` when none is (or it fails to decrypt). Server-internal
   * only - the `{ secret }` ref resolver's read path; route handlers must
   * NEVER put this into a response body, use `secretStatus()`/`listSecrets()`.
   */
  getSecret(name: string): string | undefined {
    const record = this.loadRecords().named?.[name];
    if (!record) return undefined;
    return this.decrypt(record);
  }

  /** Removes the secret stored under `name`. No-ops when none is stored. */
  removeSecret(name: string): void {
    const records = this.loadRecords();
    if (records.named && name in records.named) {
      delete records.named[name];
      this.saveRecords(records);
    }
  }

  /**
   * `name`'s masked status: `hasValue: false` with `null`s when nothing
   * is stored (or the record no longer decrypts - a tampered ciphertext
   * reads the same as absent). Safe to return from a GET route.
   */
  secretStatus(name: string): SecretStatus {
    const record = this.loadRecords().named?.[name];
    if (!record) return { name, hasValue: false, masked: null, updatedAt: null };
    const value = this.decrypt(record);
    return { name, hasValue: value !== undefined, masked: value !== undefined ? maskKey(value) : null, updatedAt: record.updatedAt };
  }

  /** Masked status of every stored named secret, sorted by name - safe to return from a GET route. */
  listSecrets(): SecretStatus[] {
    const named = this.loadRecords().named ?? {};
    return Object.keys(named)
      .sort()
      .map((name) => {
        const value = this.decrypt(named[name]);
        return { name, hasValue: value !== undefined, masked: value !== undefined ? maskKey(value) : null, updatedAt: named[name].updatedAt };
      });
  }
}
