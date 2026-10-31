/**
 * memoryFromSpec(): one validated `spec.memory` entry as the `defineMemory()`
 * slot `createAgent({ memory })` takes. `scope` passes 'global'/'session'
 * through and compiles `{ metadataKey }` to a scope function keyed on
 * `ctx.metadata[key]`; `provider` compiles to `inMemoryMemory()`,
 * `fileMemory()` (its dir resolved inside `host.baseDir`) or
 * `sqliteVectorMemory()` over a `SqliteStore` whose embedder
 * `host.resolveEmbedder` builds. The SDK never builds an embedder or a
 * JSON-Schema adapter itself - the host owns those, so a spec needing one the
 * host cannot supply is refused LOUSHO_SPEC_UNSUPPORTED at compile time.
 * Node-side, like the rest of `resolve/` - `fileMemory` pulls in `node:fs`,
 * and `node:sqlite` loads only through the dynamic import a `sqlite-vector`
 * entry triggers.
 */
import { ConfigurationError } from '../../../execution/errors';
import { defineMemory, type MemoryProvider, type MemoryScope, type MemorySlot } from '../../../memory/defineMemory';
import type { EmbeddingProvider } from '../../../memory/embeddings';
import { fileMemory } from '../../../memory/fileMemory';
import { inMemoryMemory } from '../../../memory/providers';
import type { StandardSchemaV1 } from '../../../utils/zodCompat';
import { specFilePath } from '../files';
import type { MemoryProviderSpec, MemoryScopeSpec, MemorySpec } from '../memory';

/** What memoryFromSpec needs from the runtime host (S16's SpecHost extends it). */
export interface MemoryHost {
  /** Directory `file` dirs and `sqlite-vector` paths resolve against (absolute). */
  baseDir: string;
  /** Builds an embedder for an id such as 'openai/text-embedding-3-small'. Required for sqlite-vector. */
  resolveEmbedder?: (id: string) => EmbeddingProvider | Promise<EmbeddingProvider>;
  /** JSON Schema → Standard Schema (S15's adapter, passed in by S16). Required for itemJsonSchema. */
  toStandardSchema?: (jsonSchema: Record<string, unknown>) => StandardSchemaV1;
}

/** `{ maxItems }` only when the spec sets it, so the provider's own default stands otherwise. */
function maxItemsOf(spec: { maxItems?: number }): { maxItems?: number } {
  return spec.maxItems === undefined ? {} : { maxItems: spec.maxItems };
}

/** The spec scope as a `MemoryScope`: the strings pass through; `{ metadataKey }` keys items on `ctx.metadata[key]`. */
function scopeOf(scope: MemoryScopeSpec): MemoryScope {
  if (scope === 'global' || scope === 'session') return scope;
  const key = scope.metadataKey;
  return (ctx) => {
    const value = ctx.metadata?.[key];
    return typeof value === 'string' && value !== '' ? `${key}:${value}` : undefined;
  };
}

/**
 * `{ type: 'sqlite-vector' }`: a `SqliteStore` at `spec.path` (default
 * '.lousho/memory.db') under `host.baseDir`, the embedder built by
 * `host.resolveEmbedder(spec.embedder)`. Both modules import dynamically so
 * `node:sqlite` is only loaded when a spec actually uses this provider.
 */
async function sqliteVectorProvider(
  spec: Extract<MemoryProviderSpec, { type: 'sqlite-vector' }>,
  name: string,
  host: MemoryHost
): Promise<MemoryProvider> {
  if (host.resolveEmbedder === undefined) {
    throw new ConfigurationError(
      `memory '${name}': sqlite-vector needs host.resolveEmbedder to build the embedder for '${spec.embedder}'.`,
      'memory',
      'LOUSHO_SPEC_UNSUPPORTED'
    );
  }
  const { SqliteStore } = await import('../../../storage/sqlite/SqliteStore');
  const { sqliteVectorMemory } = await import('../../../storage/sqlite/sqliteVectorMemory');
  const store = new SqliteStore(specFilePath(host.baseDir, 'memory', spec.path ?? '.lousho/memory.db'));
  return sqliteVectorMemory(store, {
    embedder: await host.resolveEmbedder(spec.embedder),
    ...maxItemsOf(spec),
    ...(spec.minScore !== undefined && { minScore: spec.minScore }),
  });
}

/** One builder per provider kind; `spec.provider.type` picks the row. `file` resolves `dir` inside `host.baseDir`. */
const PROVIDERS: {
  [T in MemoryProviderSpec['type']]: (spec: Extract<MemoryProviderSpec, { type: T }>, name: string, host: MemoryHost) => Promise<MemoryProvider>;
} = {
  'in-memory': async (spec) => inMemoryMemory(maxItemsOf(spec)),
  file: async (spec, _name, host) => fileMemory({ dir: specFilePath(host.baseDir, 'memory', spec.dir), ...maxItemsOf(spec) }),
  'sqlite-vector': sqliteVectorProvider,
};

/** The provider `spec.provider` describes, built by the {@link PROVIDERS} row its `type` selects. */
function providerOf(spec: MemoryProviderSpec, name: string, host: MemoryHost): Promise<MemoryProvider> {
  // The row for spec.type takes exactly spec's narrowed type; the indexed access cannot see that.
  const build = PROVIDERS[spec.type] as (spec: MemoryProviderSpec, name: string, host: MemoryHost) => Promise<MemoryProvider>;
  return build(spec, name, host);
}

/**
 * One spec memory entry as a `MemorySlot`. `sqlite-vector` without
 * `host.resolveEmbedder` and `itemJsonSchema` without `host.toStandardSchema`
 * are LOUSHO_SPEC_UNSUPPORTED; everything else delegates to `defineMemory()`,
 * which applies its own defaults (`recall.maxItems` 10, `expose.forget` false, ...).
 */
export async function memoryFromSpec(spec: MemorySpec, host: MemoryHost): Promise<MemorySlot> {
  if (spec.itemJsonSchema !== undefined && host.toStandardSchema === undefined) {
    throw new ConfigurationError(
      `memory '${spec.name}': itemJsonSchema needs host.toStandardSchema to turn it into a schema.`,
      'memory',
      'LOUSHO_SPEC_UNSUPPORTED'
    );
  }
  const provider = await providerOf(spec.provider, spec.name, host);
  return defineMemory({
    name: spec.name,
    ...(spec.description !== undefined && { description: spec.description }),
    scope: scopeOf(spec.scope),
    provider,
    ...(spec.recall !== undefined && { recall: spec.recall }),
    ...(spec.expose !== undefined && { expose: spec.expose }),
    ...(spec.itemJsonSchema !== undefined && { itemSchema: host.toStandardSchema!(spec.itemJsonSchema) }),
    ...(spec.itemKey !== undefined && { itemKey: spec.itemKey }),
  });
}
