/**
 * The `tokens` part of `SqliteStore` (N9a): sealed records in the
 * `oauth_tokens` and `oauth_pending` tables. Encryption, validation and
 * expiry live in `SealedTokenStore`; this file only moves opaque strings.
 */
import { SealedTokenStore, type SealedRecordBackend, type TokenStoreOptions } from '../../oauth/sealedTokenStore';
import type { Connection } from './connection';
import { Statements } from './stores';

class SqliteTokenBackend implements SealedRecordBackend {
  private readonly sql: Statements;
  constructor(private readonly connection: Connection) {
    this.sql = new Statements(connection);
  }

  async get(key: string): Promise<string | undefined> {
    const row = this.sql.get('SELECT payload FROM oauth_tokens WHERE key = ?').get(key);
    return row === undefined ? undefined : String(row.payload);
  }

  async put(key: string, sealed: string): Promise<void> {
    this.sql
      .get(
        `INSERT INTO oauth_tokens (key, payload, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      )
      .run(key, sealed, Date.now());
  }

  async delete(key: string): Promise<void> {
    this.sql.get('DELETE FROM oauth_tokens WHERE key = ?').run(key);
  }

  async list(prefix: string): Promise<Array<{ key: string; sealed: string }>> {
    // substr() rather than LIKE: a prefix holds '%' from percent-encoding.
    const rows = this.sql.get('SELECT key, payload FROM oauth_tokens WHERE substr(key, 1, ?) = ? ORDER BY key').all(prefix.length, prefix);
    return rows.map((row) => ({ key: String(row.key), sealed: String(row.payload) }));
  }

  async putPending(state: string, sealed: string, expiresAt: number): Promise<void> {
    this.sql
      .get(
        `INSERT INTO oauth_pending (state, payload, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(state) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at`
      )
      .run(state, sealed, expiresAt);
  }

  /** Read and delete in one write transaction: of two callers, one gets the row. */
  async takePending(state: string): Promise<string | undefined> {
    return this.connection.transaction(() => {
      const row = this.sql.get('SELECT payload FROM oauth_pending WHERE state = ?').get(state);
      if (row === undefined) return undefined;
      this.sql.get('DELETE FROM oauth_pending WHERE state = ?').run(state);
      return String(row.payload);
    });
  }
}

/** The encrypted `OAuthTokenStore` over `connection`. */
export function sqliteTokenStore(connection: Connection, options: TokenStoreOptions): SealedTokenStore {
  return new SealedTokenStore(new SqliteTokenBackend(connection), 'SqliteStore', options);
}
