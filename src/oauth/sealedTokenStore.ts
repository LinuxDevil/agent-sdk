/**
 * The encrypted `OAuthTokenStore` (N9a) shared by the persistent stores:
 * `SqliteStore`, `KVStore` and `fileStore` each supply a small backend of
 * opaque sealed strings, and this class does validation, encryption and
 * expiry. No `node:*` import: `KVStore` bundles it.
 *
 * Records (each sealed with the record key as AAD):
 *   tokens   `<provider>|app`, `<provider>|user|<issuer>|<principalId>`
 *   clients  `<provider>|client`
 *   pending  `pending:<state>` (AAD; the backend stores it by state)
 */
import { TokenCipher, type TokenKeyInput } from './tokenCipher';
import {
  assertPendingInput,
  assertToken,
  clientKey,
  isValidState,
  listPrefix,
  matchesList,
  ownerFromKey,
  tokenStoreKey,
} from './tokenStoreKey';
import type { OAuthToken, OAuthTokenInfo, OAuthTokenListOptions, OAuthTokenStore, PendingSignIn, TokenOwner } from './types';

/** Opaque storage of sealed strings, one per record key. */
export interface SealedRecordBackend {
  /** The sealed token or client record at `key`. */
  get(key: string): Promise<string | undefined>;
  put(key: string, sealed: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Every token or client record whose key starts with `prefix` (`''`: all). */
  list(prefix: string): Promise<Array<{ key: string; sealed: string }>>;
  /** Store a pending sign-in until `expiresAt` (ms since the epoch). */
  putPending(state: string, sealed: string, expiresAt: number): Promise<void>;
  /** Remove and return a pending sign-in (atomically where the backend can); expired ones may still be returned, the caller checks. */
  takePending(state: string): Promise<string | undefined>;
}

/** Options of the persistent stores' `tokens` part. */
export interface TokenStoreOptions {
  /** 32 random bytes as base64 (or several, newest first, to rotate); default `LOUSHO_TOKEN_KEY`. */
  tokenKey?: TokenKeyInput;
}

interface TokenRecord {
  token: OAuthToken;
  updatedAt: number;
}

interface PendingRecord {
  value: PendingSignIn;
  expiresAt: number;
}

const pendingAad = (state: string): string => `pending:${state}`;

/** Copy only the known fields, so nothing else a caller attached is persisted. */
export function cleanToken(token: OAuthToken): OAuthToken {
  const copy: OAuthToken = { accessToken: token.accessToken };
  if (token.refreshToken !== undefined) copy.refreshToken = token.refreshToken;
  if (token.tokenType !== undefined) copy.tokenType = token.tokenType;
  if (token.expiresAt !== undefined) copy.expiresAt = token.expiresAt;
  if (token.scope !== undefined) copy.scope = token.scope;
  return copy;
}

/** The metadata of a stored token: never `accessToken` or `refreshToken`. */
export function tokenInfo(provider: string, owner: TokenOwner, token: OAuthToken, updatedAt: number): OAuthTokenInfo {
  const info: OAuthTokenInfo = { provider, owner, hasRefreshToken: typeof token.refreshToken === 'string' && token.refreshToken !== '', updatedAt };
  if (token.tokenType !== undefined) info.tokenType = token.tokenType;
  if (token.expiresAt !== undefined) info.expiresAt = token.expiresAt;
  if (token.scope !== undefined) info.scope = token.scope;
  return info;
}

/** An `OAuthTokenStore` that encrypts every record before it reaches `backend`. */
export class SealedTokenStore implements OAuthTokenStore {
  private readonly cipher: TokenCipher;

  /**
   * @param storeName names the store in a missing-key error, e.g. `'SqliteStore'`
   * @throws `ConfigurationError` when `tokenKey` (or `LOUSHO_TOKEN_KEY`) is set but is not 32 bytes of base64
   */
  constructor(
    private readonly backend: SealedRecordBackend,
    storeName: string,
    options: TokenStoreOptions = {}
  ) {
    this.cipher = TokenCipher.fromOption(options.tokenKey, storeName);
  }

  /** Decrypt `sealed`; with no key configured, a stored record is a missing-key error (it exists but cannot be read). */
  private async openRecord<T>(sealed: string, aad: string, label: string): Promise<T> {
    return JSON.parse(await this.cipher.open(sealed, aad, label)) as T;
  }

  async get(provider: string, owner: TokenOwner): Promise<OAuthToken | undefined> {
    const key = tokenStoreKey(provider, owner);
    const sealed = await this.backend.get(key);
    if (sealed === undefined) return undefined;
    return (await this.openRecord<TokenRecord>(sealed, key, `token for provider "${provider}"`)).token;
  }

  async set(provider: string, owner: TokenOwner, token: OAuthToken): Promise<void> {
    const key = tokenStoreKey(provider, owner);
    assertToken(token);
    const record: TokenRecord = { token: cleanToken(token), updatedAt: Date.now() };
    await this.backend.put(key, await this.cipher.seal(JSON.stringify(record), key));
  }

  async delete(provider: string, owner: TokenOwner): Promise<void> {
    await this.backend.delete(tokenStoreKey(provider, owner));
  }

  async list(options: OAuthTokenListOptions = {}): Promise<OAuthTokenInfo[]> {
    const { prefix, exact } = listPrefix(options);
    const rows = (await this.backend.list(prefix)).filter(({ key }) => (exact ? key === prefix : matchesList(key, options)));
    const infos: OAuthTokenInfo[] = [];
    for (const { key, sealed } of rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
      const { provider, owner } = ownerFromKey(key)!;
      const record = await this.openRecord<TokenRecord>(sealed, key, `token for provider "${provider}"`);
      infos.push(tokenInfo(provider, owner, record.token, record.updatedAt));
    }
    return infos;
  }

  async putPending(state: string, value: PendingSignIn, ttlMs: number): Promise<void> {
    assertPendingInput(state, value, ttlMs);
    const expiresAt = Date.now() + ttlMs;
    const record: PendingRecord = { value: structuredClone(value), expiresAt };
    await this.backend.putPending(state, await this.cipher.seal(JSON.stringify(record), pendingAad(state)), expiresAt);
  }

  async takePending(state: string): Promise<PendingSignIn | undefined> {
    if (!isValidState(state)) return undefined; // state arrives from a callback URL: a malformed one was never stored
    const sealed = await this.backend.takePending(state);
    if (sealed === undefined) return undefined;
    const record = await this.openRecord<PendingRecord>(sealed, pendingAad(state), 'pending sign-in');
    return record.expiresAt > Date.now() ? record.value : undefined;
  }

  async getClient(provider: string): Promise<Record<string, unknown> | undefined> {
    const key = clientKey(provider);
    const sealed = await this.backend.get(key);
    if (sealed === undefined) return undefined;
    return (await this.openRecord<{ client: Record<string, unknown> }>(sealed, key, `client for provider "${provider}"`)).client;
  }

  async setClient(provider: string, client: Record<string, unknown>): Promise<void> {
    const key = clientKey(provider);
    await this.backend.put(key, await this.cipher.seal(JSON.stringify({ client }), key));
  }
}
