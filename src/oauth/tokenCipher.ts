/**
 * The cipher of the OAuth token store (N9a): AES-256-GCM through Web Crypto
 * (`crypto.subtle`), so it runs unchanged in Node and in a Cloudflare Worker.
 * No `node:*` import here: `KVStore` bundles this file.
 *
 * - The key is 32 random bytes the application supplies as base64 (option
 *   `tokenKey`, else the `LOUSHO_TOKEN_KEY` environment variable). There is
 *   no default and nothing is derived from a password.
 * - Every write draws a fresh random 12-byte IV.
 * - The record key is the additional authenticated data, so a ciphertext
 *   copied to another record fails to decrypt.
 * - Stored form: `v1.<base64 iv>.<base64 ciphertext and tag>`.
 * - Rotation: give several keys (newest first, or comma-separated in the
 *   environment variable). Writes use the first; reads try each in order.
 *
 * Errors never carry plaintext, ciphertext or key material.
 */
import { ConfigurationError, SDKError } from '../execution/errors';

/** Environment variable read when no `tokenKey` option is given. */
const TOKEN_KEY_ENV = 'LOUSHO_TOKEN_KEY';

/** The `tokenKey` option: one base64 key, or several (newest first) to read records written under an older one. */
export type TokenKeyInput = string | readonly string[];

const VERSION = 'v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Strict base64 decode; `undefined` for anything that is not canonical base64. */
function fromBase64(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) return undefined;
  try {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
}

/** 32 random bytes as base64: a new `tokenKey` / `LOUSHO_TOKEN_KEY`. */
export function generateTokenKey(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

/** The keys given as `option`, else in `LOUSHO_TOKEN_KEY` (comma-separated, newest first); `[]` when there are none. */
function keyStrings(option: TokenKeyInput | undefined): string[] {
  if (option !== undefined) return (typeof option === 'string' ? [option] : [...option]).map((key) => String(key).trim());
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[TOKEN_KEY_ENV];
  if (env === undefined || env.trim() === '') return [];
  return env.split(',').map((key) => key.trim());
}

/** Parse and check the keys: each must decode to exactly 32 bytes. The message never shows a key. */
function parseKeys(option: TokenKeyInput | undefined): Uint8Array<ArrayBuffer>[] {
  const source = option === undefined ? TOKEN_KEY_ENV : 'tokenKey';
  return keyStrings(option).map((text, index) => {
    const bytes = fromBase64(text);
    if (bytes?.length !== KEY_BYTES) {
      throw new ConfigurationError(
        `Invalid OAuth token key${option === undefined || typeof option === 'string' ? '' : ` at index ${index}`} in ${source}: ` +
          'it must be 32 random bytes as base64 (generateTokenKey() makes one).',
        source
      );
    }
    return bytes;
  });
}

/** An error that names the record but never the token. */
function decryptFailed(label: string): SDKError {
  return new SDKError(
    `Could not decrypt the stored OAuth ${label}: the token key is not the one it was written with, or the record was changed or moved.`,
    'LOUSHO_TOKEN_DECRYPT_FAILED'
  );
}

/**
 * Seals and opens token records. Construct it with {@link TokenCipher.fromOption};
 * a cipher without keys can still be asked {@link hasKey}, and throws
 * `LOUSHO_TOKEN_KEY_MISSING` from {@link seal} and {@link open}.
 */
export class TokenCipher {
  private cryptoKeys?: Promise<CryptoKey[]>;

  private constructor(
    private readonly rawKeys: Uint8Array<ArrayBuffer>[],
    private readonly storeName: string
  ) {}

  /**
   * The cipher of a persistent store: the `tokenKey` option, else `LOUSHO_TOKEN_KEY`.
   * Throws a `ConfigurationError` now when a key is given but malformed; a
   * missing key is reported on first use.
   */
  static fromOption(option: TokenKeyInput | undefined, storeName: string): TokenCipher {
    return new TokenCipher(parseKeys(option), storeName);
  }

  /** Whether a key is configured. */
  get hasKey(): boolean {
    return this.rawKeys.length > 0;
  }

  private keys(): Promise<CryptoKey[]> {
    if (!this.hasKey) {
      throw new ConfigurationError(
        `${this.storeName} has no OAuth token key: pass tokenKey (32 random bytes as base64, from generateTokenKey()) or set ${TOKEN_KEY_ENV}.`,
        'tokenKey',
        'LOUSHO_TOKEN_KEY_MISSING'
      );
    }
    this.cryptoKeys ??= Promise.all(
      this.rawKeys.map((raw) => crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']))
    );
    return this.cryptoKeys;
  }

  /** Encrypt `plaintext` under the newest key, bound to `aad` (the record key). */
  async seal(plaintext: string, aad: string): Promise<string> {
    const [key] = await this.keys();
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) },
      key,
      new TextEncoder().encode(plaintext)
    );
    return `${VERSION}.${toBase64(iv)}.${toBase64(new Uint8Array(sealed))}`;
  }

  /**
   * Decrypt a {@link seal}ed record bound to `aad`, trying each key in order.
   * `label` names the record in the error (e.g. `token for provider "github"`).
   */
  async open(sealed: string, aad: string, label: string): Promise<string> {
    const keys = await this.keys();
    const parts = typeof sealed === 'string' ? sealed.split('.') : [];
    const iv = parts.length === 3 && parts[0] === VERSION ? fromBase64(parts[1]) : undefined;
    const data = iv?.length === IV_BYTES ? fromBase64(parts[2]) : undefined;
    if (!iv || !data) throw decryptFailed(label);
    const additionalData = new TextEncoder().encode(aad);
    for (const key of keys) {
      try {
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData }, key, data);
        return new TextDecoder().decode(plain);
      } catch {
        // wrong key (or tampered record): try the next one
      }
    }
    throw decryptFailed(label);
  }
}
