/**
 * `kvMemory()` (agent directories on Cloudflare Workers): a `MemoryProvider`
 * for `memory/*.ts` slots in an agent directory built with
 * `lousho build --target=cloudflare-worker`.
 *
 * A memory file is evaluated at module load, before any request - and a
 * Worker's KV namespace only exists on `env`, per request. So `kvMemory()`
 * returns a provider marked for late binding: the Worker runtime
 * (runtime.worker.ts) swaps it, via {@link bindWorkerMemoryProvider}, for a
 * provider on `env[binding]` (the `AGENT_CHECKPOINTS` namespace sessions and
 * approvals already use, under `memory/` keys), or for an in-memory provider
 * when that binding is not declared - the same fail-open rule as
 * `workerStore()`. Used anywhere else (e.g. `createAgent()` on Node), the
 * provider fails with a message saying where it belongs.
 *
 * Node-free: only the structural `KVBinding` and Web APIs, so it bundles into
 * the Worker.
 */
import type { MemoryItem, MemoryProvider } from '../memory/defineMemory';
import { inMemoryMemory, itemsProvider, type MemoryProviderOptions } from '../memory/providers';
import { SDKError } from '../execution/errors';
import { CHECKPOINT_KV_BINDING } from './checkpointBinding';
import { isKVBinding, type KVBinding } from './kvCheckpointStore';

/** Options of {@link kvMemory}. */
export interface KVMemoryOptions extends MemoryProviderOptions {
  /**
   * Name of the `env` binding holding the KV namespace. Defaults to
   * `AGENT_CHECKPOINTS` (the namespace the generated `wrangler.toml` already
   * declares for sessions, checkpoints and approvals; memory items then live
   * under `memory/` keys of the same namespace).
   */
  binding?: string;
}

const KV_MEMORY = Symbol('lousho.kvMemory');

/** A `kvMemory()` provider before the Worker binds it to `env`: its methods throw. */
interface DeferredKVMemory extends MemoryProvider {
  [KV_MEMORY]: { binding: string; options: MemoryProviderOptions };
}

/** One scope key's items under `memory/<key>` of `kv`, as JSON. */
function kvItemsProvider(kv: KVBinding, options: MemoryProviderOptions): MemoryProvider {
  return itemsProvider(
    {
      async load(key) {
        const raw = await kv.get(`memory/${key}`);
        return raw === null ? [] : (JSON.parse(raw) as MemoryItem[]);
      },
      async save(key, items) {
        await kv.put(`memory/${key}`, JSON.stringify(items));
      },
    },
    options
  );
}

function unbound(): never {
  throw new SDKError(
    "kvMemory() has no memory store yet: it is bound to the Worker's KV namespace when the generated Worker " +
      'handles a request. Outside `lousho build --target=cloudflare-worker` use inMemoryMemory() or fileMemory().',
    'LOUSHO_MEMORY_INVALID'
  );
}

/**
 * A memory provider on a Workers KV namespace, for `memory/*.ts` slots of an
 * agent directory deployed to a Cloudflare Worker:
 *
 * ```ts
 * // memory/notes.ts
 * import { defineMemory, kvMemory } from '@lousho/build-ai-agent';
 * export default defineMemory({ name: 'notes', scope: 'global', provider: kvMemory() });
 * ```
 *
 * The binding is looked up on `env` per request (default `AGENT_CHECKPOINTS`,
 * or `binding`); when it is not declared, items are kept in the memory of one
 * isolate - fine for trying a deploy out, not for production. KV is
 * eventually consistent and a read-modify-write is not atomic, so two writes
 * of one scope key at the same moment can overwrite each other (the same
 * caveat as `KVStore`).
 */
export function kvMemory({ binding = CHECKPOINT_KV_BINDING, ...options }: KVMemoryOptions = {}): MemoryProvider {
  const provider: DeferredKVMemory = { [KV_MEMORY]: { binding, options }, list: unbound, add: unbound, remove: unbound };
  return provider;
}

/**
 * The provider to run a turn with: `provider` itself, unless it came from
 * `kvMemory()` - then a provider on `env[its binding]` (or an in-memory one
 * when the binding is not declared).
 */
export function bindWorkerMemoryProvider(provider: MemoryProvider, env: Record<string, unknown>): MemoryProvider {
  const deferred = (provider as DeferredKVMemory)[KV_MEMORY];
  if (deferred === undefined) return provider;
  const binding = env[deferred.binding];
  return isKVBinding(binding) ? kvItemsProvider(binding, deferred.options) : inMemoryMemory(deferred.options);
}
