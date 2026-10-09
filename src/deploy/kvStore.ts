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
import { oldestFirst, type ApprovalStore, type ExecutionSnapshot, type PendingApproval, type ResolvedApproval } from '../execution/ApprovalGate';
import type { Message } from '../providers/llm';
import { assertSessionId } from '../session/sessionId';
import type { SessionStore } from '../session/sessionStore';
import type { AgentStore } from '../storage/agentStore';
import type { OAuthTokenStore } from '../oauth/types';
import type { TokenKeyInput } from '../oauth/tokenCipher';
import { kvTokenStore } from './kvTokenStore';
import { DEFAULT_KV_KEY_PREFIX, KVCheckpointStore, type KVBinding } from './kvCheckpointStore';
import { fromKVJson, toKVJson } from './kvBytes';
import { newId } from '../utils/id';

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

/** Seconds a resolve's claim marker lives (KV's minimum TTL): a request that dies mid-resolve frees the approval again after it. */
const CLAIM_TTL_SECONDS = 60;

/**
 * Eve DUR-F9: KV has no compare-and-swap, so resolving claims the approval
 * first: it writes a random token under `<id>#claim` (unless a claim is
 * already there), reads it back, and only the request whose token survived
 * deletes the record and runs the call. That turns two concurrent decisions
 * (a double click, a retried webhook, two reviewers) into one in the common
 * case; it is not atomic - two requests at different edge locations within
 * KV's propagation delay can still both win - so the approved tool also gets
 * the approval id as `ctx.approval.id`, an idempotency key for its side
 * effect (docs/cloudflare-workers.md).
 */
class KVApprovalStore implements ApprovalStore {
  constructor(
    private readonly kv: KVBinding,
    private readonly prefix: string,
    private readonly ttl?: number
  ) {}

  private claimKey(id: string): string {
    return `${this.prefix}${id}#claim`;
  }

  async save(pending: PendingApproval, snapshot: ExecutionSnapshot): Promise<void> {
    const record: ResolvedApproval = { pending, snapshot };
    await this.kv.put(`${this.prefix}${pending.id}`, toKVJson(record), putOptions(this.ttl));
    // A pause saved again (a refused resume, a sign-in) is decidable again.
    await this.kv.delete(this.claimKey(pending.id));
  }

  async resolve(id: string): Promise<ResolvedApproval | null> {
    const raw = await this.kv.get(`${this.prefix}${id}`);
    if (raw === null) return null;
    if ((await this.kv.get(this.claimKey(id))) !== null) return null;
    const token = newId('claim');
    await this.kv.put(this.claimKey(id), token, { expirationTtl: CLAIM_TTL_SECONDS });
    if ((await this.kv.get(this.claimKey(id))) !== token) return null;
    await this.kv.delete(`${this.prefix}${id}`);
    return fromKVJson<ResolvedApproval>(raw);
  }

  async load(id: string): Promise<ResolvedApproval | null> {
    const raw = await this.kv.get(`${this.prefix}${id}`);
    return raw === null ? null : fromKVJson<ResolvedApproval>(raw);
  }

  /**
   * Eve TOOLS-F13: every approval under the prefix, oldest first; `[]` when the
   * binding has no `list`. KV is eventually consistent, so a pause saved or
   * resolved in the last ~60 seconds elsewhere may be missing or still listed.
   */
  async list(): Promise<PendingApproval[]> {
    if (!this.kv.list) return [];
    const names = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.kv.list({ prefix: this.prefix, ...(cursor !== undefined && { cursor }) });
      for (const { name } of page.keys) names.add(name);
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor !== undefined);
    const found: PendingApproval[] = [];
    for (const name of names) {
      // A `#claim` marker is not a record, and a record with one is being resolved.
      if (name.endsWith('#claim') || names.has(`${name}#claim`)) continue;
      const raw = await this.kv.get(name);
      if (raw !== null) found.push(fromKVJson<ResolvedApproval>(raw).pending);
    }
    return oldestFirst(found);
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
