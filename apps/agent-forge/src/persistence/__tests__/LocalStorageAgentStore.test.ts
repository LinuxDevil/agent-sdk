import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentSpec } from '@lousho/build-ai-agent';
import { LocalStorageAgentStore } from '../LocalStorageAgentStore';

/**
 * A minimal in-memory `Storage`-compatible stub, used instead of jsdom's
 * `window.localStorage`: at time of writing, this repo's Node/vitest
 * combination (Node 26's experimental built-in `localStorage` global vs.
 * jsdom's own implementation) leaves `window.localStorage` undefined in
 * the test environment even with a valid origin configured. Real browsers
 * are unaffected - `LocalStorageAgentStore`'s no-arg constructor still
 * defaults to `window.localStorage` for actual app usage (see
 * `state/AppState.tsx`) - this stub only exercises the class's logic
 * against the same `Storage` interface via its constructor injection seam.
 */
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

const spec: AgentSpec = {
  name: 'doc-qa',
  prompt: 'Answer questions about the docs.',
  provider: { type: 'mock', model: 'mock-1' },
  tools: ['http'],
};

describe('LocalStorageAgentStore', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('round-trips save/load for a spec', async () => {
    const store = new LocalStorageAgentStore(storage);
    await store.save('doc-qa', spec);
    const loaded = await store.load('doc-qa');
    expect(loaded).toEqual(spec);
  });

  it('returns undefined for an id that was never saved', async () => {
    const store = new LocalStorageAgentStore(storage);
    expect(await store.load('nope')).toBeUndefined();
  });

  it('lists saved entries sorted by id, ignoring unrelated localStorage keys', async () => {
    const store = new LocalStorageAgentStore(storage);
    storage.setItem('unrelated-key', 'noise');
    await store.save('b-agent', spec);
    await store.save('a-agent', spec);

    const entries = await store.list();
    expect(entries.map((e) => e.id)).toEqual(['a-agent', 'b-agent']);
    expect(entries[0].spec).toEqual(spec);
    expect(typeof entries[0].updatedAt).toBe('string');
  });

  it('removes a saved entry', async () => {
    const store = new LocalStorageAgentStore(storage);
    await store.save('doc-qa', spec);
    await store.remove('doc-qa');
    expect(await store.load('doc-qa')).toBeUndefined();
  });
});
