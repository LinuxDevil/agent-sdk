/**
 * #298: `kvMemory()` marks a memory provider for late binding to the Worker's
 * KV namespace; `bindWorkerMemoryProvider()` swaps it for the KV-backed (or,
 * unbound, in-memory) provider when a request arrives.
 */
import { describe, it, expect } from 'vitest';
import { bindWorkerMemoryProvider, kvMemory } from './workerMemory';
import { inMemoryMemory } from '../memory/providers';
import type { KVBinding } from './kvCheckpointStore';

/** A KVBinding over a Map, for tests. */
function fakeKv(map = new Map<string, string>()): KVBinding & { map: Map<string, string> } {
  return {
    map,
    get: async (key) => map.get(key) ?? null,
    put: async (key, value) => void map.set(key, value),
    delete: async (key) => void map.delete(key),
  };
}

describe('kvMemory (#298)', () => {
  it('throws until it is bound, naming what it is for', () => {
    const provider = kvMemory();
    expect(() => provider.list('global')).toThrow(/lousho build --target=cloudflare-worker/);
  });

  it('keeps items under memory/<scopeKey> of the AGENT_CHECKPOINTS binding by default', async () => {
    const kv = fakeKv();
    const provider = bindWorkerMemoryProvider(kvMemory(), { AGENT_CHECKPOINTS: kv });
    const item = await provider.add('global', { text: 'likes tea' });
    expect(JSON.parse(kv.map.get('memory/global') as string)).toEqual([item]);
    expect((await provider.list('global')).map((i) => i.text)).toEqual(['likes tea']);
    await provider.remove('global', item.id);
    expect(await provider.list('global')).toEqual([]);
  });

  it('honours a custom binding name', async () => {
    const kv = fakeKv();
    const provider = bindWorkerMemoryProvider(kvMemory({ binding: 'AGENT_MEMORY' }), { AGENT_MEMORY: kv });
    await provider.add('user:1', { text: 'x' });
    expect(kv.map.has('memory/user:1')).toBe(true);
  });

  it('falls back to an in-memory provider when the binding is absent or not a KV namespace', async () => {
    for (const env of [{}, { AGENT_CHECKPOINTS: 'nope' }]) {
      const provider = bindWorkerMemoryProvider(kvMemory(), env);
      await provider.add('global', { text: 'lost with the isolate' });
      expect((await provider.list('global')).map((i) => i.text)).toEqual(['lost with the isolate']);
    }
  });

  it('leaves other providers (e.g. inMemoryMemory()) untouched', () => {
    const provider = inMemoryMemory();
    expect(bindWorkerMemoryProvider(provider, {})).toBe(provider);
  });
});
