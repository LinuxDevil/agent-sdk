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
 */
import { Checkpoint, CheckpointStore } from '../execution/checkpoint';

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
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
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
  constructor(
    private readonly kv: KVBinding,
    private readonly keyPrefix: string = DEFAULT_KV_KEY_PREFIX
  ) {}

  private key(sessionId: string): string {
    return `${this.keyPrefix}${sessionId}`;
  }

  async save(sessionId: string, checkpoint: Checkpoint): Promise<void> {
    await this.kv.put(this.key(sessionId), JSON.stringify(checkpoint));
  }

  async load(sessionId: string): Promise<Checkpoint | null> {
    const raw = await this.kv.get(this.key(sessionId));
    if (raw === null) return null;
    return JSON.parse(raw) as Checkpoint;
  }

  async delete(sessionId: string): Promise<void> {
    await this.kv.delete(this.key(sessionId));
  }
}
