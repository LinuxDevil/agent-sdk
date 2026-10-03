/**
 * The `tokens` part of `KVStore` (N9a): sealed records in Workers KV.
 *
 *   `<prefix>oauth/tokens/<key>`     a token or a registered client (key: tokenStoreKey() or `<provider>|client`)
 *   `<prefix>oauth/pending/<state>`  a pending sign-in, written with `expirationTtl`
 *
 * KV has no transactions: `takePending` reads and then deletes, so a state
 * value is single use only as far as KV's eventual consistency allows (two
 * callbacks at different edge locations within a minute could both read it).
 * The state is 256 random bits, so replaying it is useless to anyone who did
 * not already have it. Encryption and expiry are `SealedTokenStore`'s.
 */
import { ConfigurationError } from '../execution/errors';
import { SealedTokenStore, type SealedRecordBackend, type TokenStoreOptions } from '../oauth/sealedTokenStore';
import type { KVBinding } from './kvCheckpointStore';

/** KV refuses an `expirationTtl` under 60 seconds; the record's own expiry is exact. */
const MIN_KV_TTL_SECONDS = 60;

class KVTokenBackend implements SealedRecordBackend {
  constructor(
    private readonly kv: KVBinding,
    private readonly tokensPrefix: string,
    private readonly pendingPrefix: string
  ) {}

  async get(key: string): Promise<string | undefined> {
    return (await this.kv.get(`${this.tokensPrefix}${key}`)) ?? undefined;
  }

  async put(key: string, sealed: string): Promise<void> {
    await this.kv.put(`${this.tokensPrefix}${key}`, sealed);
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(`${this.tokensPrefix}${key}`);
  }

  async list(prefix: string): Promise<Array<{ key: string; sealed: string }>> {
    if (typeof this.kv.list !== 'function') {
      throw new ConfigurationError('KVStore tokens.list() needs a KV binding with list(); pass the Workers KV namespace itself.', 'kv');
    }
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.kv.list({ prefix: `${this.tokensPrefix}${prefix}`, cursor });
      names.push(...page.keys.map((entry) => entry.name));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    const rows: Array<{ key: string; sealed: string }> = [];
    for (const name of names) {
      const sealed = await this.kv.get(name);
      if (sealed !== null) rows.push({ key: name.slice(this.tokensPrefix.length), sealed }); // deleted since the list: skip
    }
    return rows;
  }

  async putPending(state: string, sealed: string, expiresAt: number): Promise<void> {
    const expirationTtl = Math.max(MIN_KV_TTL_SECONDS, Math.ceil((expiresAt - Date.now()) / 1000));
    await this.kv.put(`${this.pendingPrefix}${state}`, sealed, { expirationTtl });
  }

  async takePending(state: string): Promise<string | undefined> {
    const key = `${this.pendingPrefix}${state}`;
    const sealed = await this.kv.get(key);
    if (sealed === null) return undefined;
    await this.kv.delete(key);
    return sealed;
  }
}

/** The encrypted `OAuthTokenStore` on `kv`, under `<prefix>oauth/`. */
export function kvTokenStore(kv: KVBinding, prefix: string, options: TokenStoreOptions): SealedTokenStore {
  return new SealedTokenStore(new KVTokenBackend(kv, `${prefix}oauth/tokens/`, `${prefix}oauth/pending/`), 'KVStore', options);
}
