/**
 * The `tokens` part of `memoryStore()` (N9a): plain objects in Maps, copied
 * on the way in and out, for as long as the process lives. Not encrypted:
 * nothing is written anywhere. Pending sign-ins expire by their `ttlMs`.
 */
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
import { cleanToken, tokenInfo } from './sealedTokenStore';
import type { OAuthToken, OAuthTokenInfo, OAuthTokenListOptions, OAuthTokenStore, PendingSignIn, TokenOwner } from './types';

/** An in-memory {@link OAuthTokenStore}. */
export class MemoryTokenStore implements OAuthTokenStore {
  private readonly records = new Map<string, { token: OAuthToken; updatedAt: number } | { client: Record<string, unknown> }>();
  private readonly pending = new Map<string, { value: PendingSignIn; expiresAt: number }>();

  async get(provider: string, owner: TokenOwner): Promise<OAuthToken | undefined> {
    const record = this.records.get(tokenStoreKey(provider, owner));
    return record && 'token' in record ? structuredClone(record.token) : undefined;
  }

  async set(provider: string, owner: TokenOwner, token: OAuthToken): Promise<void> {
    const key = tokenStoreKey(provider, owner);
    assertToken(token);
    this.records.set(key, { token: cleanToken(token), updatedAt: Date.now() });
  }

  async delete(provider: string, owner: TokenOwner): Promise<void> {
    this.records.delete(tokenStoreKey(provider, owner));
  }

  async list(options: OAuthTokenListOptions = {}): Promise<OAuthTokenInfo[]> {
    listPrefix(options); // validates the filter
    return [...this.records.keys()]
      .filter((key) => matchesList(key, options))
      .sort()
      .map((key) => {
        const record = this.records.get(key) as { token: OAuthToken; updatedAt: number };
        const { provider, owner } = ownerFromKey(key)!;
        return tokenInfo(provider, owner, record.token, record.updatedAt);
      });
  }

  async putPending(state: string, value: PendingSignIn, ttlMs: number): Promise<void> {
    assertPendingInput(state, value, ttlMs);
    const now = Date.now();
    for (const [key, entry] of this.pending) if (entry.expiresAt <= now) this.pending.delete(key);
    this.pending.set(state, { value: structuredClone(value), expiresAt: now + ttlMs });
  }

  async takePending(state: string): Promise<PendingSignIn | undefined> {
    if (!isValidState(state)) return undefined;
    const entry = this.pending.get(state);
    this.pending.delete(state);
    return entry && entry.expiresAt > Date.now() ? entry.value : undefined;
  }

  async getClient(provider: string): Promise<Record<string, unknown> | undefined> {
    const record = this.records.get(clientKey(provider));
    return record && 'client' in record ? structuredClone(record.client) : undefined;
  }

  async setClient(provider: string, client: Record<string, unknown>): Promise<void> {
    this.records.set(clientKey(provider), { client: structuredClone(client) });
  }
}
