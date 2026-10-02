/**
 * Cloudflare Workers KV-backed `CheckpointStore` (LOU-T2).
 *
 * Why KV and not D1/Durable Objects: a Worker deployment already has `env`
 * bindings (see runtime.worker.ts's `providerEnvKey()`/`prepareWorkerSpec()`
 * precedent), and Workers KV is the standard zero-extra-infra "durable
 * key-value blob, keyed by a single string" primitive for that runtime - a
 * Checkpoint is exactly that shape (one JSON blob per `sessionId`, read and
 * written whole, never queried/filtered). D1 (SQL) and Durable Objects
 * (single-instance strongly-consistent actors) are both a heavier fit for
 * this: D1 buys relational query power this store never needs, and Durable
 * Objects buys strong consistency at the cost of provisioning a DO class/
 * migration and paying for a stateful object per session - overkill for
 * "save this blob, load it later, on a rare pause/resume cycle". If a
 * consumer's workload later needs strict read-after-write consistency
 * across edge locations (see the KV eventual-consistency note below), a
 * Durable-Object-backed CheckpointStore would be the natural upgrade path -
 * this file doesn't preclude one, it just isn't the default.
 *
 * Zero Node builtins: this module only touches the injected `KVBinding`
 * interface (a structural subset of Cloudflare's real `KVNamespace` type -
 * `get`/`put`/`delete` - just enough of it that this file doesn't need
 * `@cloudflare/workers-types` as a runtime dependency) and JSON/global
 * fetch-runtime primitives, so it bundles cleanly for the `cloudflare-worker`
 * build target exactly like runtime.worker.ts and its shims do.
 *
 * IMPORTANT - eventual consistency: Workers KV is an eventually-consistent
 * store. A `put()` is immediately visible to the edge location that issued
 * it, but can take up to ~60 seconds to propagate to other edge locations
 * globally (see Cloudflare's KV documentation). For this SDK's pause/resume
 * use case that means: if an approval-gated run pauses on one edge location
 * and the human's approval decision is handled by a request that lands on a
 * *different* edge location shortly after, `load()` on that second location
 * could still observe the pre-pause checkpoint (or, on a fresh session, a
 * miss) rather than the just-written one. This store does not - and, given
 * KV's guarantees, cannot - promise strict read-after-write consistency
 * across locations. Consumers whose approval workflow can't tolerate that
 * window should route a given session's requests to a single Cloudflare
 * location (e.g. via Durable Object routing) or use a strongly-consistent
 * store instead. See docs/deployment.md's `cloudflare-worker` section for
 * the consumer-facing version of this caveat.
 *
 * History (LOU-D43.2): next to the latest checkpoint (`<prefix><sessionId>`,
 * unchanged, so a store written before history existed still loads) each
 * session keeps an index key `<prefix><sessionId>#history` (an oldest-first
 * JSON list of entry ids) and one key per entry,
 * `<prefix><sessionId>#history/<id>`, holding the history entry. KV has no
 * transactions, so `save()` writes the latest checkpoint, then the entry, then
 * the index, then deletes the entries the index dropped. A crash between
 * writes leaves at worst an orphan entry no index lists (it expires with the
 * TTL), never an index row that breaks reading (a row whose entry is missing
 * is skipped). Caveat: the index is a read-modify-write, so two concurrent
 * saves of one session can lose one index update (that entry then never shows
 * in `history()`); route a session's requests to one location when that
 * matters. Each save costs one `get` and two `put`s more; `historyLimit: 0`
 * turns the history off.
 */
import {
  appendToRing,
  newestFirst,
  resolveHistoryLimit,
  toHistoryEntry,
  type Checkpoint,
  type CheckpointDeleteOptions,
  type CheckpointHistoryEntry,
  type CheckpointHistoryOptions,
  type CheckpointStore,
} from '../execution/checkpoint';
import { newId } from '../utils/id';

/** The `put()` option the stores use: seconds until the key expires (KV accepts 60 or more). */
export interface KVPutOptions {
  expirationTtl?: number;
}

/**
 * The minimal structural subset of Cloudflare's real `KVNamespace` binding
 * type that `KVCheckpointStore` needs. Deliberately NOT imported from
 * `@cloudflare/workers-types` (not a dependency of this package) so this
 * file has zero external type dependencies and stays trivially mockable in
 * tests (see kvCheckpointStore.test.ts) - any object satisfying this shape,
 * real or a plain in-memory mock, works.
 */
export interface KVBinding {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: KVPutOptions): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys under a prefix, a page at a time. Optional: only `KVStore`'s `tokens.list()` needs it (a real KV namespace has it). */
  list?(options: KVListOptions): Promise<KVListResult>;
}

/** Options of {@link KVBinding.list}, as on a real KV namespace. */
export interface KVListOptions {
  prefix?: string;
  cursor?: string;
}

/** One page of {@link KVBinding.list}; `cursor` continues it while `list_complete` is false. */
export interface KVListResult {
  keys: Array<{ name: string }>;
  list_complete: boolean;
  cursor?: string;
}

/** Default key prefix `KVCheckpointStore` namespaces its keys under. */
export const DEFAULT_KV_KEY_PREFIX = 'checkpoints/';

/**
 * `CheckpointStore` implementation backed by a single Cloudflare Workers KV
 * namespace binding, keyed by `${keyPrefix}${sessionId}`. See this module's
 * doc comment above for the eventual-consistency caveat that applies to
 * every method here.
 */
export class KVCheckpointStore implements CheckpointStore {
  private readonly historyLimit: number;

  constructor(
    private readonly kv: KVBinding,
    private readonly keyPrefix: string = DEFAULT_KV_KEY_PREFIX,
    /** Seconds a saved checkpoint is kept (LOU-D51); omit to keep it until deleted. */
    private readonly expirationTtl?: number,
    /** `historyLimit`: checkpoints kept per session in `history()` (default 50, `0` keeps none). */
    options: { historyLimit?: number } = {}
  ) {
    this.historyLimit = resolveHistoryLimit(options.historyLimit);
  }

  private key(sessionId: string): string {
    return `${this.keyPrefix}${sessionId}`;
  }

  private indexKey(sessionId: string): string {
    return `${this.key(sessionId)}#history`;
  }

  private entryKey(sessionId: string, id: string): string {
    return `${this.indexKey(sessionId)}/${id}`;
  }

  private put(key: string, value: unknown): Promise<void> {
    return this.kv.put(key, JSON.stringify(value), this.expirationTtl ? { expirationTtl: this.expirationTtl } : undefined);
  }

  /** The session's entry ids, oldest first; an unreadable index counts as empty. */
  private async readIndex(sessionId: string): Promise<string[]> {
    const raw = await this.kv.get(this.indexKey(sessionId));
    if (raw === null) return [];
    try {
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  }

  async save(sessionId: string, checkpoint: Checkpoint): Promise<void> {
    await this.put(this.key(sessionId), checkpoint);
    if (this.historyLimit === 0) return;
    const id = `${String(Date.now()).padStart(15, '0')}-${newId()}`;
    const index = await this.readIndex(sessionId);
    const kept = appendToRing(index, id, this.historyLimit);
    await this.put(this.entryKey(sessionId, id), toHistoryEntry(checkpoint));
    await this.put(this.indexKey(sessionId), kept);
    await Promise.all(index.filter((old) => !kept.includes(old)).map((old) => this.kv.delete(this.entryKey(sessionId, old))));
  }

  async load(sessionId: string): Promise<Checkpoint | null> {
    const raw = await this.kv.get(this.key(sessionId));
    if (raw === null) return null;
    return JSON.parse(raw) as Checkpoint;
  }

  async delete(sessionId: string, options: CheckpointDeleteOptions = {}): Promise<void> {
    await this.kv.delete(this.key(sessionId));
    if (options.keepHistory) return;
    const index = await this.readIndex(sessionId);
    await Promise.all(index.map((id) => this.kv.delete(this.entryKey(sessionId, id))));
    await this.kv.delete(this.indexKey(sessionId));
  }

  /** Newest first; an entry the index lists but KV does not return (not yet propagated, expired) is skipped. */
  async history(sessionId: string, options?: CheckpointHistoryOptions): Promise<CheckpointHistoryEntry[]> {
    const ids = newestFirst(await this.readIndex(sessionId), options);
    const entries = await Promise.all(
      ids.map(async (id) => {
        const raw = await this.kv.get(this.entryKey(sessionId, id));
        return raw === null ? null : (JSON.parse(raw) as CheckpointHistoryEntry);
      })
    );
    return entries.filter((entry): entry is CheckpointHistoryEntry => entry !== null);
  }
}
