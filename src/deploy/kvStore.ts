/**
 * `KVStore` (LOU-D51): an `AgentStore` on one Cloudflare Workers KV namespace,
 * so a deployed Worker keeps session transcripts, durable-execution
 * checkpoints and paused approvals between requests:
 *
 *   `<prefix>sessions/<id>`      a transcript as JSON
 *   `<prefix>checkpoints/<id>`   a Checkpoint (KVCheckpointStore, with its history)
 *   `<prefix>approvals/<id>`     a pending approval and its snapshot
 *   `<prefix>oauth/...`          OAuth tokens and sign-ins, encrypted (kvTokenStore.ts)
 *
 * No Node builtins: only the structural `KVBinding` and Web APIs, so it bundles
 * into the Worker. KV is eventually consistent: a write can take up to ~60
 * seconds to reach other edge locations (see kvCheckpointStore.ts), and a
 * read-modify-write is not atomic, so two requests of one session at the same
 * time can overwrite each other's turn. Route a session's requests to one
 * location (a Durable Object) when that matters.
 */
import type { ApprovalStore, ExecutionSnapshot, PendingApproval, ResolvedApproval } from '../execution/ApprovalGate';
import type { Message } from '../providers/llm';
import { assertSessionId } from '../session/sessionId';
import type { SessionStore } from '../session/sessionStore';
import type { AgentStore } from '../storage/agentStore';
import type { OAuthTokenStore } from '../oauth/types';
import type { TokenKeyInput } from '../oauth/tokenCipher';
import { kvTokenStore } from './kvTokenStore';
import { DEFAULT_KV_KEY_PREFIX, KVCheckpointStore, type KVBinding } from './kvCheckpointStore';
import { fromKVJson, toKVJson } from './kvBytes';

/** Options of {@link KVStore}. */
export interface KVStoreOptions {
  /** Put before every key, to share one namespace with other data (default none). */
  prefix?: string;
  /** Seconds each kind of record is kept after its last write; KV accepts 60 or more. Omit to keep records until deleted. */
  ttl?: { sessions?: number; checkpoints?: number; approvals?: number };
  /** Checkpoints kept per session in `checkpoints.history()` (default 50, `0` keeps none; LOU-D43.2). */
  historyLimit?: number;
  /**
   * Key of the OAuth tokens in `store.tokens`: 32 random bytes as base64
   * (`generateTokenKey()`), or several, newest first, to read tokens written
   * under an older key. Default: `LOUSHO_TOKEN_KEY` where `process.env`
   * exists; on Workers pass `env.LOUSHO_TOKEN_KEY` (a secret) here.
   */
  tokenKey?: TokenKeyInput;
}

const putOptions = (expirationTtl?: number) => (expirationTtl ? { expirationTtl } : undefined);

class KVSessionStore implements SessionStore {
  constructor(
    private readonly kv: KVBinding,
    private readonly prefix: string,
    private readonly ttl?: number
  ) {}

  private key(id: string): string {
    assertSessionId(id);
    return `${this.prefix}${id}`;
  }

  async load(id: string): Promise<Message[] | undefined> {
    const raw = await this.kv.get(this.key(id));
    return raw === null ? undefined : fromKVJson<Message[]>(raw);
  }

  async save(id: string, messages: readonly Message[]): Promise<void> {
    await this.kv.put(this.key(id), toKVJson(messages), putOptions(this.ttl));
  }

  async delete(id: string): Promise<void> {
    await this.kv.delete(this.key(id));
  }
}

/** Resolving reads the record and then deletes it: two requests deciding one approval at once can both get it. */
class KVApprovalStore implements ApprovalStore {
  constructor(
    private readonly kv: KVBinding,
    private readonly prefix: string,
    private readonly ttl?: number
  ) {}

  async save(pending: PendingApproval, snapshot: ExecutionSnapshot): Promise<void> {
    const record: ResolvedApproval = { pending, snapshot };
    await this.kv.put(`${this.prefix}${pending.id}`, toKVJson(record), putOptions(this.ttl));
  }

  async resolve(id: string): Promise<ResolvedApproval | null> {
    const raw = await this.kv.get(`${this.prefix}${id}`);
    if (raw === null) return null;
    await this.kv.delete(`${this.prefix}${id}`);
    return fromKVJson<ResolvedApproval>(raw);
  }

  async load(id: string): Promise<ResolvedApproval | null> {
    const raw = await this.kv.get(`${this.prefix}${id}`);
    return raw === null ? null : fromKVJson<ResolvedApproval>(raw);
  }
}

/**
 * An {@link AgentStore} on a Workers KV namespace binding, for
 * `createAgent({ store })` inside a Worker.
 *
 * @example
 * ```ts
 * const agent = createAgent({ provider, store: new KVStore(env.AGENT_KV, { ttl: { sessions: 86_400 } }) });
 * ```
 */
export class KVStore implements Required<AgentStore> {
  readonly sessions: SessionStore;
  readonly checkpoints: KVCheckpointStore;
  readonly approvals: ApprovalStore;
  /** OAuth tokens, pending sign-ins and registered clients, encrypted with `tokenKey` (docs/oauth.md). */
  readonly tokens: OAuthTokenStore;

  /** @throws `ConfigurationError` when `tokenKey` (or `LOUSHO_TOKEN_KEY`) is set but is not 32 bytes of base64 */
  constructor(kv: KVBinding, { prefix = '', ttl = {}, historyLimit, tokenKey }: KVStoreOptions = {}) {
    this.sessions = new KVSessionStore(kv, `${prefix}sessions/`, ttl.sessions);
    this.checkpoints = new KVCheckpointStore(kv, `${prefix}${DEFAULT_KV_KEY_PREFIX}`, ttl.checkpoints, { historyLimit });
    this.approvals = new KVApprovalStore(kv, `${prefix}approvals/`, ttl.approvals);
    this.tokens = kvTokenStore(kv, prefix, { tokenKey });
  }
}
