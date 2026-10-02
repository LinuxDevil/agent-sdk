import { SDKError } from '../execution/errors';
/**
 * Memory slots (LOU-W6): named, scoped long-term memory an agent recalls at
 * the start of a run and reads / writes with `remember_<name>` and
 * `recall_<name>` tools. Storage is a pluggable `MemoryProvider`.
 */

/** One remembered item. */
export interface MemoryItem {
  id: string;
  text: string;
  /** ISO 8601 timestamp. */
  createdAt: string;
  metadata?: Record<string, unknown>;
}

/** Where a slot's items are kept, per scope key. `list()` returns the newest items first. */
export interface MemoryProvider {
  list(scopeKey: string, options?: { limit?: number; query?: string }): Promise<MemoryItem[]>;
  /** Stores `item` and returns it with its `id` and `createdAt`. */
  add(scopeKey: string, item: { text: string; metadata?: Record<string, unknown> }): Promise<MemoryItem>;
  remove(scopeKey: string, id: string): Promise<void>;
}

/** What a scope function gets: the run's session id and `send()` metadata. */
export interface MemoryScopeContext {
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Whose memory a run sees: one shared memory (`'global'`), one per session
 * (`'session'`), or a key computed from the run (e.g. a user id in metadata).
 * A run without a key (no session, or the function returns `undefined`) gets
 * no recall and no tools for the slot.
 */
export type MemoryScope = 'global' | 'session' | ((ctx: MemoryScopeContext) => string | undefined);

/** Options for {@link defineMemory}. */
export interface DefineMemoryOptions {
  /** Slot name: 1-55 characters of `A-Za-z0-9_-` (the tools are `remember_<name>` and `recall_<name>`). */
  name: string;
  /** What this memory holds; shown to the model in the tool descriptions. */
  description?: string;
  scope: MemoryScope;
  provider: MemoryProvider;
  /**
   * Recall at the start of a run: on its first model call, the newest
   * `maxItems` (default 10) items go into the system prompt in a
   * `<memory name="...">` block. `query: 'last-input'` passes the last user
   * message to the provider as `query` (default `'none'`).
   */
  recall?: { onSessionStart?: boolean; maxItems?: number; query?: 'last-input' | 'none' };
  /** Which tools the model gets. Both default to `true`. */
  expose?: { remember?: boolean; recall?: boolean };
}

/** A memory slot made by {@link defineMemory}, defaults applied. Pass it to `createAgent({ memory })`. */
export interface MemorySlot {
  readonly name: string;
  readonly description?: string;
  readonly scope: MemoryScope;
  readonly provider: MemoryProvider;
  readonly recall: { onSessionStart: boolean; maxItems: number; query: 'last-input' | 'none' };
  readonly expose: { remember: boolean; recall: boolean };
}

const SLOT_NAME = /^[a-zA-Z0-9_-]{1,55}$/;

/**
 * Defines a memory slot.
 *
 * @example
 * ```ts
 * const notes = defineMemory({ name: 'notes', scope: 'global', provider: inMemoryMemory() });
 * const agent = createAgent({ model: 'openai/gpt-4o-mini', memory: [notes] });
 * ```
 */
export function defineMemory(options: DefineMemoryOptions): MemorySlot {
  const { name, description, scope, provider, recall = {}, expose = {} } = options;
  if (typeof name !== 'string' || !SLOT_NAME.test(name)) {
    throw new SDKError(`defineMemory: invalid name ${JSON.stringify(name)}. Use 1-55 characters of A-Z, a-z, 0-9, '_' and '-'.`, 'LOUSHY_MEMORY_INVALID');
  }
  if (typeof provider?.list !== 'function' || typeof provider.add !== 'function') {
    throw new SDKError(`defineMemory: memory '${name}' needs a provider, e.g. inMemoryMemory() or fileMemory({ dir }).`, 'LOUSHY_MEMORY_INVALID');
  }
  const maxItems = recall.maxItems ?? 10;
  if (!Number.isInteger(maxItems) || maxItems < 1) {
    throw new SDKError(`defineMemory: memory '${name}': recall.maxItems must be a positive integer, got ${maxItems}.`, 'LOUSHY_MEMORY_INVALID');
  }
  return Object.freeze({
    name,
    ...(description !== undefined && { description }),
    scope,
    provider,
    recall: { onSessionStart: recall.onSessionStart ?? true, maxItems, query: recall.query ?? 'none' },
    expose: { remember: expose.remember ?? true, recall: expose.recall ?? true },
  });
}
