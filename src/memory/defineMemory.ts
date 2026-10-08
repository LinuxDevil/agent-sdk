import { SDKError } from '../execution/errors';
import type { Principal } from '../auth/types';
import { isModelSchema, type StandardSchemaV1 } from '../utils/zodCompat';
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
  /** The order `list()` gives for a query: `'newest'` (default) or `'relevance'` (by meaning). Only changes how the `recall_<name>` tool is described. */
  readonly ranking?: 'newest' | 'relevance';
  list(scopeKey: string, options?: { limit?: number; query?: string }): Promise<MemoryItem[]>;
  /**
   * Stores `item` and returns it with its `id` and `createdAt`. The built-in
   * providers dedupe on `text`: adding an item whose text is already stored
   * returns the stored item instead of a duplicate.
   */
  add(scopeKey: string, item: { text: string; metadata?: Record<string, unknown> }): Promise<MemoryItem>;
  remove(scopeKey: string, id: string): Promise<void>;
}

/** What a scope function gets: the run's session id, `send()` metadata and (N10a) the verified caller. */
export interface MemoryScopeContext {
  sessionId?: string;
  metadata?: Record<string, unknown>;
  /**
   * The caller a route's auth accepted, or a channel's sender (docs/auth.md).
   * Key per-user memory on `issuer` and `id` together: ids from different issuers can collide.
   */
  principal?: Principal;
}

/**
 * Whose memory a run sees: one shared memory (`'global'`), one per session
 * (`'session'`), or a key computed from the run (e.g. a user id in metadata).
 * A run without a key (no session, or the function returns `undefined`) gets
 * no recall and no tools for the slot.
 */
export type MemoryScope = 'global' | 'session' | ((ctx: MemoryScopeContext) => string | undefined);

/**
 * The provider key a slot's items live under for a run that sees `ctx`:
 * `<slot name>#<scope key>` (`notes#global`, `prefs#session:s1`,
 * `user_facts#user:u-42`). The slot name is part of the key so two slots that
 * resolve to the same scope keep separate item lists — share a provider (and a
 * scope) between slots safely. `undefined` when the run has no scope key. Use
 * it to seed, read or prune a slot's items from code:
 * `provider.add(memoryKey(notes)!, { text })`.
 */
export function memoryKey(slot: MemorySlot, ctx: MemoryScopeContext = {}): string | undefined {
  const scope =
    slot.scope === 'global' ? 'global' : slot.scope === 'session' ? ctx.sessionId && `session:${ctx.sessionId}` : slot.scope(ctx);
  return scope ? `${slot.name}#${scope}` : undefined;
}

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
  /**
   * Schema of `remember_<name>`'s input (zod 3 or 4, or a Standard Schema).
   * Default: `{ text: string }` — the item's text is that string. When set,
   * the parsed arguments are stored instead: `text` is their canonical JSON
   * (stable key order) and `metadata` is the parsed object, so a slot can
   * enforce structured state rather than free text. `recall_<name>` returns
   * the same JSON text.
   */
  itemSchema?: StandardSchemaV1;
}

/** A memory slot made by {@link defineMemory}, defaults applied. Pass it to `createAgent({ memory })`. */
export interface MemorySlot {
  readonly name: string;
  readonly description?: string;
  readonly scope: MemoryScope;
  readonly provider: MemoryProvider;
  readonly recall: { onSessionStart: boolean; maxItems: number; query: 'last-input' | 'none' };
  readonly expose: { remember: boolean; recall: boolean };
  readonly itemSchema?: StandardSchemaV1;
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
  const { name, description, scope, provider, recall = {}, expose = {}, itemSchema } = options;
  if (typeof name !== 'string' || !SLOT_NAME.test(name)) {
    throw new SDKError(`defineMemory: invalid name ${JSON.stringify(name)}. Use 1-55 characters of A-Z, a-z, 0-9, '_' and '-'.`, 'LOUSHO_MEMORY_INVALID');
  }
  if (typeof provider?.list !== 'function' || typeof provider.add !== 'function') {
    throw new SDKError(`defineMemory: memory '${name}' needs a provider, e.g. inMemoryMemory() or fileMemory({ dir }).`, 'LOUSHO_MEMORY_INVALID');
  }
  if (itemSchema !== undefined && !isModelSchema(itemSchema)) {
    throw new SDKError(
      `defineMemory: memory '${name}': itemSchema must be a zod schema (zod 3 or 4) or a Standard Schema.`,
      'LOUSHO_MEMORY_INVALID'
    );
  }
  const maxItems = recall.maxItems ?? 10;
  if (!Number.isInteger(maxItems) || maxItems < 1) {
    throw new SDKError(`defineMemory: memory '${name}': recall.maxItems must be a positive integer, got ${maxItems}.`, 'LOUSHO_MEMORY_INVALID');
  }
  return Object.freeze({
    name,
    ...(description !== undefined && { description }),
    scope,
    provider,
    recall: { onSessionStart: recall.onSessionStart ?? true, maxItems, query: recall.query ?? 'none' },
    expose: { remember: expose.remember ?? true, recall: expose.recall ?? true },
    ...(itemSchema !== undefined && { itemSchema }),
  });
}
