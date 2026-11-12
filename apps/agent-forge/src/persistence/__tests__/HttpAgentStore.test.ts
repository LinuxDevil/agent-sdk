import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentSpecV2 } from 'lousho';
import { HttpAgentStore, type AgentApi } from '../HttpAgentStore';
import type { AgentListItem, AgentMeta, AgentRecord, CanvasLayout } from '../../../shared/wireTypes';

const spec = (name: string): AgentSpecV2 => ({
  version: 2,
  name,
  model: 'mock/mock-1',
  instructions: 'You are a helpful agent.',
});

const layout = (): CanvasLayout => ({
  schemaVersion: 1,
  nodes: { agent: { x: 100, y: 200 } },
  notes: [],
});

const meta = (): AgentMeta => ({
  schemaVersion: 1,
  enabled: true,
  disabledAt: null,
  disabledReason: null,
  failureStreak: 0,
  labels: [],
  publishedVersion: null,
  createdAt: 't',
  updatedAt: 't',
});

const record = (id: string, s: AgentSpecV2, l: CanvasLayout): AgentRecord => ({
  id,
  spec: s,
  meta: meta(),
  layout: l,
  updatedAt: 't',
  latestVersion: null,
  publishState: { version: null, matchesWorkingCopy: false, publishedAt: null },
});

const listItem = (id: string): AgentListItem => ({
  id,
  name: id,
  description: '',
  model: 'mock/mock-1',
  enabled: true,
  labels: [],
  updatedAt: 't',
  publishedVersion: null,
  counts: { tools: 0, mcpServers: 0, subagents: 0, triggers: 0 },
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
  records = new Map<string, AgentRecord>();
  online = true;
  constructor(public baseDir: string) {}
  private check(): void {
    if (!this.online) throw new TypeError('Failed to fetch');
  }
  async listAgents(): Promise<AgentListItem[]> {
    this.check();
    return [...this.records.keys()].map(listItem);
  }
  async loadAgent(id: string): Promise<AgentRecord | undefined> {
    this.check();
    return this.records.get(id);
  }
  async saveAgent(id: string, s: AgentSpecV2): Promise<void> {
    this.check();
    const existing = this.records.get(id);
    this.records.set(id, { ...record(id, s, existing?.layout ?? layout()), meta: existing?.meta ?? meta() });
  }
  async saveLayout(id: string, l: CanvasLayout): Promise<void> {
    this.check();
    const existing = this.records.get(id);
    if (existing) this.records.set(id, { ...existing, layout: l });
  }
  async deleteAgent(id: string): Promise<void> {
    this.check();
    this.records.delete(id);
  }
  async workspace(): Promise<{ baseDir: string }> {
    this.check();
    return { baseDir: this.baseDir };
  }
}

/**
 * The agent list used to live in `localStorage` - shared by
 * every project opened in the browser, blind to `.lousho/agents/`, and
 * unknown to the server, so chat on a new agent failed until Run.
 */
describe('HttpAgentStore', () => {
  let storage: MemoryStorage;
  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('lists the agents already on disk in the server workspace', async () => {
    const server = new FakeServer('/proj-a');
    server.records.set('from-disk', record('from-disk', spec('from-disk'), layout()));
    const store = new HttpAgentStore(server, storage);
    expect((await store.list()).map((e) => e.id)).toEqual(['from-disk']);
    expect((await store.load('from-disk'))?.spec).toEqual(spec('from-disk'));
  });

  it('saves the spec to the server (PUT { spec }), not to the browser', async () => {
    const server = new FakeServer('/proj-a');
    const store = new HttpAgentStore(server, storage);
    await store.save('new-agent', spec('new-agent'));
    expect(server.records.get('new-agent')?.spec).toEqual(spec('new-agent'));
    expect(storage.length).toBe(0);
  });

  it('saves the layout through PUT /agents/:id/layout', async () => {
    const server = new FakeServer('/proj-a');
    server.records.set('a1', record('a1', spec('a1'), layout()));
    const store = new HttpAgentStore(server, storage);
    const moved: CanvasLayout = { schemaVersion: 1, nodes: { agent: { x: 42, y: 7 } }, notes: [] };
    await store.saveLayout('a1', moved);
    expect(server.records.get('a1')?.layout).toEqual(moved);
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

  it('keeps an offline save as a { spec, layout } draft keyed by the workspace and pushes it on the next load', async () => {
    const server = new FakeServer('/proj-a');
    server.records.set('a1', record('a1', spec('original'), layout()));
    const store = new HttpAgentStore(server, storage);
    await store.list(); // learns the workspace while online
    server.online = false;
    await expect(store.save('a1', spec('edited'))).rejects.toThrow();
    const moved: CanvasLayout = { schemaVersion: 1, nodes: { agent: { x: 1, y: 2 } }, notes: [] };
    await expect(store.saveLayout('a1', moved)).rejects.toThrow();
    const draft = JSON.parse(storage.getItem('agent-forge:draft:/proj-a:a1')!) as { spec: AgentSpecV2; layout: CanvasLayout };
    expect(draft.spec).toEqual(spec('edited'));
    expect(draft.layout).toEqual(moved);

    // Still offline: the draft is what loads.
    expect((await store.load('a1'))?.spec).toEqual(spec('edited'));
    // Back online: the draft is pushed to the server and cleared.
    server.online = true;
    const loaded = await store.load('a1');
    expect(loaded?.spec).toEqual(spec('edited'));
    expect(loaded?.layout).toEqual(moved);
    expect(server.records.get('a1')?.spec).toEqual(spec('edited'));
    expect(server.records.get('a1')?.layout).toEqual(moved);
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
    server.records.set('gone', record('gone', spec('gone'), layout()));
    await new HttpAgentStore(server, storage).remove('gone');
    expect(server.records.has('gone')).toBe(false);
  });
});
