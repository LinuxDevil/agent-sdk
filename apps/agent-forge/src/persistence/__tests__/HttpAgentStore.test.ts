import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentSpec } from '@lousho/build-ai-agent';
import { HttpAgentStore, type AgentApi } from '../HttpAgentStore';
import type { AgentStoreEntry } from '../AgentStore';

const spec = (name: string): AgentSpec => ({
  name,
  prompt: 'You are a helpful agent.',
  provider: { type: 'mock', model: 'mock-1' },
});

/** An in-memory `Storage` (see vite.config.ts on why not jsdom's). */
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
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

/** A fake studio server: one workspace's `.lousho/agents/`, with an on/off switch. */
class FakeServer implements AgentApi {
  agents = new Map<string, AgentSpec>();
  online = true;
  constructor(public baseDir: string) {}
  private check(): void {
    if (!this.online) throw new TypeError('Failed to fetch');
  }
  async listAgents(): Promise<AgentStoreEntry[]> {
    this.check();
    return [...this.agents].map(([id, s]) => ({ id, spec: s, updatedAt: '2026-10-09T00:00:00.000Z' }));
  }
  async loadAgent(id: string): Promise<AgentSpec | undefined> {
    this.check();
    return this.agents.get(id);
  }
  async saveAgent(id: string, s: AgentSpec): Promise<void> {
    this.check();
    this.agents.set(id, s);
  }
  async deleteAgent(id: string): Promise<void> {
    this.check();
    this.agents.delete(id);
  }
  async workspace(): Promise<{ baseDir: string }> {
    this.check();
    return { baseDir: this.baseDir };
  }
}

/**
 * Eve DUI-F2/F7: the agent list used to live in `localStorage` - shared by
 * every project opened in the browser, blind to `.lousho/agents/`, and
 * unknown to the server, so chat on a new agent failed until Run.
 */
describe('HttpAgentStore (Eve DUI-F2)', () => {
  let storage: MemoryStorage;
  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('lists the agents already on disk in the server workspace', async () => {
    const server = new FakeServer('/proj-a');
    server.agents.set('from-disk', spec('from-disk'));
    const store = new HttpAgentStore(server, storage);
    expect((await store.list()).map((e) => e.id)).toEqual(['from-disk']);
    expect(await store.load('from-disk')).toEqual(spec('from-disk'));
  });

  it('saves to the server (so chat on a new agent finds its spec), not to the browser', async () => {
    const server = new FakeServer('/proj-a');
    const store = new HttpAgentStore(server, storage);
    await store.save('new-agent', spec('new-agent'));
    expect(server.agents.get('new-agent')).toEqual(spec('new-agent'));
    expect(storage.length).toBe(0);
  });

  it("does not leak one project's agents into another project's studio", async () => {
    const storageShared = storage; // same browser
    const a = new FakeServer('/proj-a');
    await new HttpAgentStore(a, storageShared).save('project-a-secret-agent', spec('x'));
    const b = new FakeServer('/proj-b');
    const storeB = new HttpAgentStore(b, storageShared);
    expect(await storeB.list()).toEqual([]);
    expect(await storeB.load('project-a-secret-agent')).toBeUndefined();
  });

  it('keeps an offline save as a draft keyed by the workspace and pushes it on the next load', async () => {
    const server = new FakeServer('/proj-a');
    const store = new HttpAgentStore(server, storage);
    await store.list(); // learns the workspace while online
    server.online = false;
    await expect(store.save('a1', spec('edited'))).rejects.toThrow();
    expect(storage.key(0)).toBe('agent-forge:draft:/proj-a:a1');

    // Still offline: the draft is what loads.
    expect(await store.load('a1')).toEqual(spec('edited'));
    // Back online: the draft is pushed to the server and cleared.
    server.online = true;
    expect(await store.load('a1')).toEqual(spec('edited'));
    expect(server.agents.get('a1')).toEqual(spec('edited'));
    expect(storage.length).toBe(0);

    // Another workspace never sees that draft.
    const other = new HttpAgentStore(new FakeServer('/proj-b'), storage);
    storage.setItem('agent-forge:draft:/proj-a:a2', JSON.stringify({ spec: spec('a-only'), savedAt: 'x' }));
    expect(await other.load('a2')).toBeUndefined();
  });

  it('does not cache a draft when the server rejects the spec (an API error)', async () => {
    const server = new FakeServer('/proj-a');
    server.saveAgent = async () => {
      throw Object.assign(new Error('Request body must be a valid AgentSpec'), { status: 400 });
    };
    const store = new HttpAgentStore(server, storage);
    await store.list();
    await expect(store.save('a1', spec('bad'))).rejects.toThrow(/valid AgentSpec/);
    expect(storage.length).toBe(0);
  });

  it('removes from the server', async () => {
    const server = new FakeServer('/proj-a');
    server.agents.set('gone', spec('gone'));
    await new HttpAgentStore(server, storage).remove('gone');
    expect(server.agents.has('gone')).toBe(false);
  });
});
