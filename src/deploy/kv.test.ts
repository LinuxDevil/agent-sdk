/**
 * R2: `@lousho/build-ai-agent/kv` must bundle for a hand-written Cloudflare
 * Worker, which has no shim for Node builtins. This guards the barrel's
 * import graph: no module it reaches may import a `node:` path.
 */
import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { join } from 'node:path';
import * as kv from './kv';

describe('@lousho/build-ai-agent/kv (R2)', () => {
  it('bundles for the browser platform with no node: import in its graph', async () => {
    const result = await build({
      entryPoints: [join(__dirname, 'kv.ts')],
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'esm',
      external: ['ai', 'zod', '@opentelemetry/api'],
      metafile: true,
      logLevel: 'silent',
    });

    expect(result.errors).toEqual([]);
    const nodeImports = Object.entries(result.metafile.inputs).flatMap(([file, input]) =>
      input.imports.filter((entry) => entry.path.startsWith('node:')).map((entry) => `${file} -> ${entry.path}`)
    );
    expect(nodeImports).toEqual([]);
    expect(Object.keys(result.metafile.inputs).some((file) => file.endsWith('kvStore.ts'))).toBe(true);
  }, 30_000);

  it('exports KVStore, KVCheckpointStore and CHECKPOINT_KV_BINDING', () => {
    expect(Object.keys(kv).sort()).toEqual(['CHECKPOINT_KV_BINDING', 'KVCheckpointStore', 'KVStore']);
    expect(kv.CHECKPOINT_KV_BINDING).toBe('AGENT_CHECKPOINTS');
    const memory = new Map<string, string>();
    const binding: kv.KVBinding = {
      get: async (key) => memory.get(key) ?? null,
      put: async (key, value, _options?: kv.KVPutOptions) => void memory.set(key, value),
      delete: async (key) => void memory.delete(key),
    };
    const options: kv.KVStoreOptions = { prefix: 'app/' };
    expect(new kv.KVStore(binding, options).checkpoints).toBeInstanceOf(kv.KVCheckpointStore);
  });
});
