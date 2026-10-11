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
  listCheckpoints,
  listedCheckpoint,
  parseCheckpoint,
  newestFirst,
  resolveHistoryLimit,
  toHistoryEntry,
  type Checkpoint,
  type CheckpointDeleteOptions,
  type CheckpointHistoryEntry,
  type CheckpointHistoryOptions,
  type CheckpointListEntry,
  type CheckpointListOptions,
  type CheckpointStore,
} from '../execution/checkpoint';
import { newId } from '../utils/id';
import { ConfigurationError } from '../execution/errors';
import { assertCheckpointId, isCheckpointId } from '../session/checkpointId';
import { fromKVJson, toKVJson } from './kvBytes';
import { decodeBytes } from '../storage/jsonBytes';

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

const KV_METHODS = ['get', 'put', 'delete'] as const;

/**
 * True when `value` has the `get`/`put`/`delete` functions of a KV namespace.
 * A bound value that does not look like a KV namespace counts as not bound:
 * `env` is arbitrary platform-supplied input, and failing open beats failing
 * every request over a misconfigured binding.
 */
export function isKVBinding(value: unknown): value is KVBinding {
  const binding = value as Partial<KVBinding> | undefined;
  return !!binding && KV_METHODS.every((method) => typeof binding[method] === 'function');
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
    // One id rule for every backend: no `#`, so a run id can never name a history key (`<id>#history`).
    assertCheckpointId(sessionId);
    return `${this.keyPrefix}${sessionId}`;
  }

  private leaseKey(sessionId: string): string {
    return `${this.key(sessionId)}#lease`;
  }

  private indexKey(sessionId: string): string {
    return `${this.key(sessionId)}#history`;
  }

  private entryKey(sessionId: string, id: string): string {
    return `${this.indexKey(sessionId)}/${id}`;
  }

  private put(key: string, value: unknown): Promise<void> {
    return this.kv.put(key, toKVJson(value), this.expirationTtl ? { expirationTtl: this.expirationTtl } : undefined);
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
    return raw === null ? null : parseCheckpoint(raw, sessionId, 'the KV namespace', decodeBytes);
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
        return raw === null ? null : fromKVJson<CheckpointHistoryEntry>(raw);
      })
    );
    return entries.filter((entry): entry is CheckpointHistoryEntry => entry !== null);
  }

  /**
   * Eve DUR-F15: the latest checkpoint of every id under the prefix, by id;
   * `[]` when the binding has no `list`. KV is eventually consistent: a
   * checkpoint written elsewhere in the last ~60 seconds may be missing or stale.
   */
  async list(options?: CheckpointListOptions): Promise<CheckpointListEntry[]> {
    if (!this.kv.list) {
      throw new ConfigurationError(
        "KVCheckpointStore.list() needs a KV binding with list() (a real Workers KV namespace has it); this binding has none, so the store's checkpoints cannot be listed.",
        'store.checkpoints'
      );
    }
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.kv.list({ prefix: this.keyPrefix, ...(cursor !== undefined && { cursor }) });
      // History keys (`<id>#history`, `<id>#history/<entry>`) are not checkpoints.
      for (const { name } of page.keys) if (!name.includes('#')) ids.push(name.slice(this.keyPrefix.length));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor !== undefined);
    const found: Array<readonly [string, Checkpoint]> = [];
    for (const id of ids.filter(isCheckpointId)) {
      const raw = await this.kv.get(this.key(id));
      // A value that cannot be read is listed as the run `load()` fails on.
      if (raw !== null) found.push(listedCheckpoint(id, () => parseCheckpoint(raw, id, 'the KV namespace', decodeBytes)));
    }
    return listCheckpoints(found, options);
  }

  /**
   * Run lease, best effort: KV has no compare-and-swap, so this reads the
   * lease, writes its own when it is free, waits {@link KV_SETTLE_MS} and reads
   * it back. Within one location that makes exactly one of two concurrent
   * callers win; across edge locations (KV propagates writes in up to ~60 s)
   * two can still both win. Route a session's requests to one location when
   * that matters.
   */
  async acquireLease(sessionId: string, owner: string, ttlMs: number): Promise<boolean> {
    const key = this.leaseKey(sessionId);
    const held = parseLease(await this.kv.get(key));
    if (held && held.owner !== owner && held.expiresAt > Date.now()) return false;
    const mine = JSON.stringify({ owner, expiresAt: Date.now() + ttlMs });
    await this.kv.put(key, mine, { expirationTtl: Math.max(60, Math.ceil(ttlMs / 1000) * 2) });
    if (held?.owner === owner) return true;
    await settle();
    return parseLease(await this.kv.get(key))?.owner === owner;
  }

  /**
   * Renews `owner`'s own run lease; `false` when another owner holds it. Best
   * effort like {@link acquireLease}: a lease KV does not return (not yet
   * visible here, or expired) is written again.
   */
  async renewLease(sessionId: string, owner: string, ttlMs: number): Promise<boolean> {
    const key = this.leaseKey(sessionId);
    const held = parseLease(await this.kv.get(key));
    if (held && held.owner !== owner) return false;
    await this.kv.put(key, JSON.stringify({ owner, expiresAt: Date.now() + ttlMs }), { expirationTtl: Math.max(60, Math.ceil(ttlMs / 1000) * 2) });
    return true;
  }

  /** Saves unless another owner holds the lease; best effort (a read, then the save), as KV has no transactions. */
  async saveIfLeased(sessionId: string, checkpoint: Checkpoint, owner: string): Promise<boolean> {
    const held = parseLease(await this.kv.get(this.leaseKey(sessionId)));
    if (held && held.owner !== owner) return false;
    await this.save(sessionId, checkpoint);
    return true;
  }

  /** Releases `owner`'s run lease on `sessionId`; a lease another owner holds is left alone. */
  async releaseLease(sessionId: string, owner: string): Promise<void> {
    const key = this.leaseKey(sessionId);
    if (parseLease(await this.kv.get(key))?.owner === owner) await this.kv.delete(key);
  }
}

/**
 * How long (ms) a KV claim waits between writing its token and reading it back.
 * A concurrent caller at the same location writes its own token within this
 * window, so of two callers only the one whose token survived wins.
 */
const KV_SETTLE_MS = 50;

/** Waits {@link KV_SETTLE_MS}. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, KV_SETTLE_MS));
}

function parseLease(raw: string | null): { owner: string; expiresAt: number } | undefined {
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw) as { owner?: unknown; expiresAt?: unknown } | null;
    return typeof parsed?.owner === 'string' && typeof parsed.expiresAt === 'number' ? { owner: parsed.owner, expiresAt: parsed.expiresAt } : undefined;
  } catch {
    return undefined;
  }
}
