/**
 * LOU-R1: local, encrypted-at-rest storage for provider API keys.
 *
 * Design and why:
 *  - Keys are NEVER written into an `AgentSpec` (the YAML this app's
 *    `fsAgentStore.ts` persists under `.lousho/agents/<id>.yaml`, which a
 *    user may reasonably commit to source control alongside the rest of
 *    their agent's definition). They live in a completely separate file,
 *    `.lousho/secrets.json`, that this app never writes an `AgentSpec` into.
 *  - `.lousho/` is already listed in the repo root `.gitignore` (added for
 *    LOU-N's checkpoints/approvals/saved-agent-spec local state) - verified
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
import type { ProviderKeyStatus } from '../shared/wireTypes';

/** Providers this app manages stored keys for - matches `src/providers/` real (non-mock) provider types that take a plain API key (not `ollama`, which uses a base URL instead - see `PROVIDER_ENV_TABLE` in `src/providers/resolveProvider.ts`). */
const SECRET_PROVIDERS = ['openai', 'anthropic'] as const;
export type SecretProvider = (typeof SECRET_PROVIDERS)[number];

export function isSecretProvider(value: string): value is SecretProvider {
  return (SECRET_PROVIDERS as readonly string[]).includes(value);
}

interface EncryptedRecord {
  iv: string;
  tag: string;
  ciphertext: string;
}

/** `••••••••<last 4>` (or all-dots for a key too short to safely reveal 4 chars of). Never called with, or able to leak, more than the last 4 characters. */
export function maskKey(key: string): string {
  if (key.length <= 4) return '••••';
  return `••••••••${key.slice(-4)}`;
}

export class SecretsStore {
  private readonly dir: string;
  private readonly keyFile: string;
  private readonly secretsFile: string;

  constructor(baseDir: string) {
    this.dir = path.join(baseDir, '.lousho');
    this.keyFile = path.join(this.dir, 'secrets.key');
    this.secretsFile = path.join(this.dir, 'secrets.json');
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

  private loadRecords(): Partial<Record<SecretProvider, EncryptedRecord>> {
    if (!fs.existsSync(this.secretsFile)) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(this.secretsFile, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private saveRecords(records: Partial<Record<SecretProvider, EncryptedRecord>>): void {
    this.ensureDir();
    fs.writeFileSync(this.secretsFile, JSON.stringify(records, null, 2), 'utf8');
    this.chmodBestEffort(this.secretsFile);
  }

  /** Encrypts and stores `apiKey` for `provider`, replacing any existing key. */
  setKey(provider: SecretProvider, apiKey: string): void {
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      throw new Error('apiKey must be a non-empty string');
    }
    const encryptionKey = this.loadOrCreateEncryptionKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    const records = this.loadRecords();
    records[provider] = {
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
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

  /** Masked status for every managed provider - safe to return from a GET route. */
  list(): ProviderKeyStatus[] {
    const records = this.loadRecords();
    return SECRET_PROVIDERS.map((provider) => {
      const hasKey = provider in records;
      const key = hasKey ? this.getKey(provider) : undefined;
      return { provider, hasKey: hasKey && !!key, masked: key ? maskKey(key) : null };
    });
  }
}
