import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ALL_WORKSPACES } from '../../../shared/workspace';
import type { AgentHost } from '../../host/agentHost';
import type { RunManager } from '../../runRegistry';
import { StudioEventBus } from '../../events/eventBus';
import { AgentRepo } from '../../storage/agentRepo';
import { DraftStore } from '../../storage/draftStore';
import { IdleVersioner } from '../../storage/idleVersioner';
import { SuggestionStore } from '../../storage/suggestionStore';
import { VersionStore } from '../../storage/versionStore';
import { PassRunner } from '../../passes/passRunner';
import type { InboxService } from '../../inbox/inboxService';
import type { TriggerHost } from '../../triggers/triggerHost';
import type { CronTriggers } from '../../triggers/cronTriggers';
import type { LegacyAgentStore } from '../../../src/persistence/AgentStore';
import { TriggerRegistry } from '@linuxdevil/lousho/triggers';
import type { WorkspaceContext } from '../context';
import type { WorkspaceRef } from '../../../shared/workspace';
import { WorkspaceRegistry } from '../workspaceRegistry';
import { WorkspaceManager } from '../workspaceManager';

/**
 * The WorkspaceManager contract (W02a): every registry id resolves over
 * HTTP, contexts build lazily and cache, warm contexts cap at `maxWarm`
 * (LRU evicted + disposed), contexts idle past `idleMs` dispose unless a
 * run is active, and `forget`/`close` dispose too. `now` is injectable so
 * the idle clock is deterministic; `sweepMs` is tiny so the interval
 * fires inside the test.
 */

const emptyStore: LegacyAgentStore = {
  list: async () => [],
  load: async () => undefined,
  save: async () => {},
  remove: async () => {},
};

interface FakeCtx extends WorkspaceContext {
  dispose: Mock<[], Promise<void>>;
  setActive: (on: boolean) => void;
}

function makeCtx(ref: WorkspaceRef, root: string): FakeCtx {
  const repo = new AgentRepo(root);
  let active = false;
  const ctx = {
    ref,
    repo,
    agentStore: emptyStore,
    versions: new VersionStore(repo),
    drafts: new DraftStore(repo),
    idleVersioner: new IdleVersioner({ capture: async () => {} }),
    suggestions: new SuggestionStore(repo),
    host: {} as AgentHost,
    runs: { hasActiveRun: () => active } as unknown as RunManager,
    chatTriggers: new TriggerRegistry(),
    events: new StudioEventBus(),
    passes: new PassRunner({ baseDir: root }),
    inbox: {} as InboxService,
    triggers: {} as TriggerHost,
    cron: {} as CronTriggers,
    dispose: vi.fn<[], Promise<void>>(async () => {}),
    setActive: (on: boolean) => {
      active = on;
    },
  };
  return ctx as FakeCtx;
}

describe('WorkspaceManager', () => {
  let dir: string;
  let tick: number;
  let registry: WorkspaceRegistry;
  let built: FakeCtx[];
  let launchRef: WorkspaceRef;
  let launch: FakeCtx;

  function folder(name: string): string {
    const root = path.join(dir, name);
    fs.mkdirSync(root, { recursive: true });
    return root;
  }

  function makeManager(overrides: Partial<ConstructorParameters<typeof WorkspaceManager>[0]> = {}) {
    return new WorkspaceManager({
      registry,
      launch,
      build: (ref) => {
        const ctx = makeCtx(ref, ref.root);
        built.push(ctx);
        return ctx;
      },
      maxWarm: 2,
      idleMs: 1000,
      sweepMs: 5,
      now: () => tick,
      ...overrides,
    });
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w02a-'));
    tick = Date.parse('2026-01-01T00:00:00.000Z');
    registry = new WorkspaceRegistry(path.join(dir, 'state', 'workspaces.json'), () => new Date(tick));
    built = [];
    launchRef = await registry.ensure(folder('launch'));
    launch = makeCtx(launchRef, launchRef.root);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('undefined and "all" resolve the launch context without building', async () => {
    const manager = makeManager();
    expect(await manager.resolve(undefined)).toBe(launch);
    expect(await manager.resolve(ALL_WORKSPACES)).toBe(launch);
    expect(built).toHaveLength(0);
    await manager.close();
  });

  it('an unknown id resolves undefined', async () => {
    const manager = makeManager();
    expect(await manager.resolve('nope-abc123')).toBeUndefined();
    expect(built).toHaveLength(0);
    await manager.close();
  });

  it('a registered id builds lazily once and caches', async () => {
    const ref = await registry.ensure(folder('alpha'));
    const manager = makeManager();
    const first = await manager.resolve(ref.id);
    expect(first?.ref.id).toBe(ref.id);
    expect(built).toHaveLength(1);
    expect(await manager.resolve(ref.id)).toBe(first);
    expect(built).toHaveLength(1);
    await manager.close();
  });

  it('the launch id resolves the launch context, never a rebuild', async () => {
    const manager = makeManager();
    expect(await manager.resolve(launchRef.id)).toBe(launch);
    expect(built).toHaveLength(0);
    await manager.close();
  });

  it('evicts the least-recently-used warm context past maxWarm and disposes it', async () => {
    const a = await registry.ensure(folder('a'));
    const b = await registry.ensure(folder('b'));
    const c = await registry.ensure(folder('c'));
    // maxWarm counts the launch context too: 3 warm = launch + 2 others.
    const manager = makeManager({ maxWarm: 3 });
    const ca = (await manager.resolve(a.id)) as FakeCtx;
    tick += 100;
    await manager.resolve(b.id);
    tick += 100;
    await manager.resolve(ca.ref.id); // touch a again -> b is now oldest
    tick += 100;
    await manager.resolve(c.id); // over cap: b evicted+disposed
    await vi.waitFor(() => expect(built[1].dispose).toHaveBeenCalled());
    // a and c stay warm; resolving b again rebuilds it
    expect(await manager.resolve(b.id)).not.toBe(built[1]);
    expect(built).toHaveLength(4);
    await manager.close();
  });

  it('does not evict a context with an active run - it warns and stays', async () => {
    const a = await registry.ensure(folder('a'));
    const b = await registry.ensure(folder('b'));
    const c = await registry.ensure(folder('c'));
    // maxWarm counts launch: 3 warm = launch + a + b, so c pushes one out.
    const manager = makeManager({ maxWarm: 3 });
    const ca = (await manager.resolve(a.id)) as FakeCtx;
    tick += 100;
    const cb = (await manager.resolve(b.id)) as FakeCtx;
    cb.setActive(true);
    tick += 100;
    await manager.resolve(ca.ref.id);
    tick += 100;
    await manager.resolve(c.id);
    // b is the LRU but has an active run: the sweep skips it and evicts a
    // (the next-oldest) instead, so the warm count still fits.
    expect(cb.dispose).not.toHaveBeenCalled();
    expect(ca.dispose).toHaveBeenCalled();
    // Still warm: resolving b returns the same context.
    expect(await manager.resolve(b.id)).toBe(cb);
    await manager.close();
  });

  it('disposes a context idle past idleMs on the sweep', async () => {
    const a = await registry.ensure(folder('a'));
    const manager = makeManager({ idleMs: 1000, sweepMs: 5 });
    const ca = (await manager.resolve(a.id)) as FakeCtx;
    tick += 2000;
    await vi.waitFor(() => expect(ca.dispose).toHaveBeenCalled(), { timeout: 2000 });
    // Next resolve rebuilds it.
    expect(await manager.resolve(a.id)).not.toBe(ca);
    await manager.close();
  });

  it('an idle context with an active run is not disposed', async () => {
    const a = await registry.ensure(folder('a'));
    const manager = makeManager({ idleMs: 1000, sweepMs: 5 });
    const ca = (await manager.resolve(a.id)) as FakeCtx;
    ca.setActive(true);
    tick += 5000;
    // Give the sweeper several chances; the active context must survive.
    await new Promise((r) => setTimeout(r, 60));
    expect(ca.dispose).not.toHaveBeenCalled();
    await manager.close();
  });

  it('forget disposes and drops the warm context (the DELETE route removes the registry entry first)', async () => {
    const a = await registry.ensure(folder('a'));
    const manager = makeManager();
    const ca = (await manager.resolve(a.id)) as FakeCtx;
    await registry.remove(a.id);
    await manager.forget(a.id);
    expect(ca.dispose).toHaveBeenCalled();
    expect(await manager.resolve(a.id)).toBeUndefined();
    await manager.close();
  });

  it('close disposes every warm context including launch', async () => {
    const a = await registry.ensure(folder('a'));
    const manager = makeManager();
    await manager.resolve(a.id);
    await manager.close();
    expect(launch.dispose).toHaveBeenCalled();
    expect(built[0].dispose).toHaveBeenCalled();
    // Idempotent: a second close is a no-op.
    await manager.close();
    expect(launch.dispose).toHaveBeenCalledTimes(1);
  });

  it('retain keeps an idle context through sweep until release; a second release is safe', async () => {
    const a = await registry.ensure(folder('a'));
    const manager = makeManager({ idleMs: 1000 });
    const ca = (await manager.resolve(a.id)) as FakeCtx;
    const release = manager.retain(a.id);
    tick += 5000;
    await manager.sweep();
    expect(ca.dispose).not.toHaveBeenCalled();
    expect(manager.warm().map((ctx) => ctx.ref.id)).toContain(a.id);

    release();
    release(); // idempotent: the second call changes nothing
    await manager.sweep();
    expect(ca.dispose).toHaveBeenCalled();
    await manager.close();
  });

  it('retain also protects a context from LRU eviction over maxWarm', async () => {
    const a = await registry.ensure(folder('a'));
    const b = await registry.ensure(folder('b'));
    const c = await registry.ensure(folder('c'));
    // maxWarm counts launch: 3 warm = launch + two others.
    const manager = makeManager({ maxWarm: 3 });
    const ca = (await manager.resolve(a.id)) as FakeCtx;
    tick += 100;
    const cb = (await manager.resolve(b.id)) as FakeCtx;
    manager.retain(b.id);
    tick += 100;
    await manager.resolve(c.id);
    // b is held: a (the next-oldest) is evicted instead.
    expect(ca.dispose).toHaveBeenCalled();
    expect(cb.dispose).not.toHaveBeenCalled();
    expect(await manager.resolve(b.id)).toBe(cb);
    await manager.close();
  });

  it('defaultId returns the launch id', async () => {
    const manager = makeManager();
    expect(manager.defaultId()).toBe(launchRef.id);
    await manager.close();
  });
});
