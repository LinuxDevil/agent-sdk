/**
 * WorkspaceManager - the registry-backed `WorkspaceResolver` (PLAN §19.3).
 *
 * Any workspace in the `WorkspaceRegistry` is reachable over HTTP: a
 * request naming `x-lousho-workspace: <id>` or `?ws=<id>` resolves to a
 * lazily-built `WorkspaceContext` over that folder's stores and
 * RunManager. Contexts are built on first use, at most `maxWarm` stay
 * warm (launch first, then most recently used), and one unused for
 * `idleMs` is disposed unless it has a run in flight.
 *
 * The launch context is always warm and never a disposal candidate.
 * `sweep()` runs on a `sweepMs` interval (`unref`ed, `0` disables it -
 * tests call `sweep()` directly) and once after each first build, so a
 * burst of new workspaces can't push the warm set over `maxWarm`.
 */
import * as fsPromises from 'node:fs/promises';
import { ALL_WORKSPACES, type WorkspaceRef } from '../../shared/workspace';
import type { WorkspaceContext, WorkspaceResolver } from './context';
import type { WorkspaceRegistry } from './workspaceRegistry';

/** Warm non-launch contexts the manager keeps before disposing the LRU idle one. */
// fallow-ignore-next-line unused-export -- W02a contract surface; the default the class applies
export const MAX_WARM_WORKSPACES = 8;
/** How long a non-launch context may sit unused before `sweep()` disposes it (no run in flight). */
// fallow-ignore-next-line unused-export -- W02a contract surface; the default the class applies
export const WORKSPACE_IDLE_MS = 10 * 60_000;
/** The background sweep cadence; `0` disables the timer (tests drive `sweep()` themselves). */
// fallow-ignore-next-line unused-export -- W02a contract surface; the default the class applies
export const WORKSPACE_SWEEP_MS = 60_000;

/** What {@link WorkspaceManager} needs: the registry, the launch context and the per-ref builder. */
export interface WorkspaceManagerOptions {
  registry: WorkspaceRegistry;
  /** The launch context - always warm, never disposed except by `close()`. */
  launch: WorkspaceContext;
  /** Builds a context for a registered ref (index.ts: `ref => createWorkspaceContext(ref, services)`). */
  build: (ref: WorkspaceRef) => WorkspaceContext;
  now?: () => number;
  /** Warm contexts including the launch one. Default {@link MAX_WARM_WORKSPACES}. */
  maxWarm?: number;
  /** Idle time before disposal. Default {@link WORKSPACE_IDLE_MS}. */
  idleMs?: number;
  /** Sweep cadence; `0` disables the timer. Default {@link WORKSPACE_SWEEP_MS}. */
  sweepMs?: number;
}

/** One warm context plus its bookkeeping. */
interface WarmEntry {
  ctx: WorkspaceContext;
  lastUsedAt: number;
  /** Set while `dispose()` is in flight so a concurrent `resolve` rebuilds instead of serving a dying context. */
  disposing?: Promise<void>;
}

export class WorkspaceManager implements WorkspaceResolver {
  private readonly contexts = new Map<string, WarmEntry>();
  private readonly building = new Map<string, Promise<WorkspaceContext>>();
  /** Open-socket holds per workspace id (W02b `retain`): sweep never disposes a held context. */
  private readonly holds = new Map<string, number>();
  /** `onBuilt`/`onDisposed` listeners (W09a): `WS /events?ws=all` follows contexts built after it connected. */
  private readonly builtListeners = new Set<(ctx: WorkspaceContext) => void>();
  private readonly disposedListeners = new Set<(id: string) => void>();
  private readonly maxWarm: number;
  private readonly idleMs: number;
  private readonly now: () => number;
  private readonly sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: WorkspaceManagerOptions) {
    this.now = options.now ?? (() => Date.now());
    this.maxWarm = options.maxWarm ?? MAX_WARM_WORKSPACES;
    this.idleMs = options.idleMs ?? WORKSPACE_IDLE_MS;
    this.contexts.set(options.launch.ref.id, { ctx: options.launch, lastUsedAt: this.now() });
    this.emitBuilt(options.launch);
    const sweepMs = options.sweepMs ?? WORKSPACE_SWEEP_MS;
    this.sweepTimer =
      sweepMs > 0
        ? setInterval(() => void this.sweep().catch((error: unknown) => console.warn('[lousho studio] workspace sweep failed:', error)), sweepMs)
        : undefined;
    this.sweepTimer?.unref();
  }

  defaultId(): string {
    return this.options.launch.ref.id;
  }

  /**
   * The context for `id`: `undefined`/`all` → launch; a warm hit marks it
   * used; a registered ref whose folder still exists builds (once, shared
   * across concurrent first requests) and sweeps capacity before return.
   * Unknown ids and vanished folders both resolve `undefined` → 404.
   */
  async resolve(id: string | undefined): Promise<WorkspaceContext | undefined> {
    if (id === undefined || id === ALL_WORKSPACES || id === this.defaultId()) {
      return this.touch(this.options.launch);
    }
    const warm = this.contexts.get(id);
    if (warm !== undefined && warm.disposing === undefined) return this.touch(warm.ctx);
    const ref = await this.options.registry.get(id);
    if (ref === undefined || !(await this.folderExists(ref.root))) return undefined;
    const ctx = await this.buildOnce(ref);
    if (ctx === undefined) return undefined;
    await this.options.registry.touch(id);
    await this.sweep();
    return ctx;
  }

  /** Warm contexts, launch first, then most recently used. */
  warm(): WorkspaceContext[] {
    const entries = [...this.contexts.values()].sort((a, b) => {
      if (a.ctx === this.options.launch) return -1;
      if (b.ctx === this.options.launch) return 1;
      return b.lastUsedAt - a.lastUsedAt;
    });
    return entries.map((entry) => entry.ctx);
  }

  /**
   * Disposes idle and over-capacity contexts: first every non-launch
   * context unused for `≥ idleMs` with no run in flight and no open-socket
   * hold; then, while more than `maxWarm` are warm, the least recently
   * used one whose `runs.hasActiveRun()` is false and that isn't held.
   * Candidates with a run in flight or a live socket are always kept -
   * going over the cap beats killing a run or a stream.
   */
  async sweep(): Promise<void> {
    const now = this.now();
    const idle = [...this.contexts.entries()].filter(
      ([id, entry]) =>
        id !== this.defaultId() &&
        entry.disposing === undefined &&
        (this.holds.get(id) ?? 0) === 0 &&
        now - entry.lastUsedAt >= this.idleMs
    );
    for (const [, entry] of idle) {
      if (!entry.ctx.runs.hasActiveRun()) await this.disposeEntry(entry);
    }
    while (this.contexts.size > this.maxWarm) {
      const lru = this.lruDisposable();
      if (lru === undefined) {
        console.warn(`[lousho studio] ${this.contexts.size} workspaces have runs in flight; keeping them open.`);
        return;
      }
      await this.disposeEntry(lru);
    }
  }

  /**
   * Increments `id`'s open-socket hold and returns the release: sweep
   * skips held contexts until every release ran. Idempotent per call -
   * the count never drops below zero and a second release is a no-op.
   */
  retain(id: string): () => void {
    this.holds.set(id, (this.holds.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.holds.get(id) ?? 1) - 1;
      if (next <= 0) this.holds.delete(id);
      else this.holds.set(id, next);
    };
  }

  /**
   * Subscribes to contexts joining the warm set (first build, W09a). The
   * launch context fires once at construction - before any listener can
   * exist - so subscribers see only later builds; `warm()` covers the
   * rest. Returns the unsubscribe.
   */
  onBuilt(listener: (ctx: WorkspaceContext) => void): () => void {
    this.builtListeners.add(listener);
    return () => this.builtListeners.delete(listener);
  }

  /** Subscribes to contexts leaving the warm set (sweep/forget/close), by workspace id. */
  onDisposed(listener: (id: string) => void): () => void {
    this.disposedListeners.add(listener);
    return () => this.disposedListeners.delete(listener);
  }

  /** Drops a removed workspace's warm context now (`DELETE /workspaces/:ws` calls it after `registry.remove`). */
  // fallow-ignore-next-line unused-class-member -- invoked structurally through app.ts's forgetWorkspace wiring
  async forget(id: string): Promise<void> {
    const entry = this.contexts.get(id);
    if (entry === undefined || id === this.defaultId()) return;
    // The registry entry is gone for good: any stale hold must not
    // protect a later rebuild of the same id.
    this.holds.delete(id);
    await this.disposeEntry(entry);
  }

  /** Disposes every context, launch included (server close). */
  async close(): Promise<void> {
    if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer);
    this.holds.clear();
    const entries = [...this.contexts.entries()];
    this.contexts.clear();
    for (const [id] of entries) this.emitDisposed(id);
    await Promise.all(entries.map(([, entry]) => this.disposeQuietly(entry.ctx)));
  }

  /** Listener failures never break a resolve/dispose - a bad subscriber is warned and skipped. */
  private emitBuilt(ctx: WorkspaceContext): void {
    for (const listener of this.builtListeners) {
      try {
        listener(ctx);
      } catch (error) {
        console.warn(`[lousho studio] onBuilt listener failed:`, error);
      }
    }
  }

  private emitDisposed(id: string): void {
    for (const listener of this.disposedListeners) {
      try {
        listener(id);
      } catch (error) {
        console.warn(`[lousho studio] onDisposed listener failed:`, error);
      }
    }
  }

  private touch(ctx: WorkspaceContext): WorkspaceContext {
    const id = ctx.ref.id;
    const entry = this.contexts.get(id);
    if (entry !== undefined) entry.lastUsedAt = this.now();
    return ctx;
  }

  /** One build per id: concurrent first requests share the in-flight promise. */
  private async buildOnce(ref: WorkspaceRef): Promise<WorkspaceContext | undefined> {
    const pending = this.building.get(ref.id);
    if (pending !== undefined) return pending;
    // A request that passed the warm check before a concurrent build
    // stored its context lands here: serve that context instead of
    // building a second one.
    const warm = this.contexts.get(ref.id);
    if (warm !== undefined && warm.disposing === undefined) return warm.ctx;
    const promise = (async () => {
      const ctx = this.options.build(ref);
      this.contexts.set(ref.id, { ctx, lastUsedAt: this.now() });
      this.emitBuilt(ctx);
      return ctx;
    })().finally(() => this.building.delete(ref.id));
    this.building.set(ref.id, promise);
    return promise;
  }

  private async folderExists(root: string): Promise<boolean> {
    const stat = await fsPromises.stat(root).catch(() => undefined);
    return stat?.isDirectory() === true;
  }

  /** The least recently used non-launch context with no run in flight and no open-socket hold, or `undefined` when every candidate is busy. */
  private lruDisposable(): WarmEntry | undefined {
    let lru: WarmEntry | undefined;
    for (const [id, entry] of this.contexts) {
      if (
        id === this.defaultId() ||
        entry.disposing !== undefined ||
        entry.ctx.runs.hasActiveRun() ||
        (this.holds.get(id) ?? 0) > 0
      )
        continue;
      if (lru === undefined || entry.lastUsedAt < lru.lastUsedAt) lru = entry;
    }
    return lru;
  }

  /** Removes the entry first, then disposes - a `resolve` during disposal rebuilds rather than serving a dying context. */
  private async disposeEntry(entry: WarmEntry): Promise<void> {
    if (entry.disposing !== undefined) return entry.disposing;
    let id: string | undefined;
    for (const [key, candidate] of this.contexts) {
      if (candidate === entry) {
        this.contexts.delete(key);
        id = key;
      }
    }
    if (id !== undefined) this.emitDisposed(id);
    const disposing = this.disposeQuietly(entry.ctx);
    entry.disposing = disposing;
    return disposing;
  }

  private async disposeQuietly(ctx: WorkspaceContext): Promise<void> {
    try {
      await ctx.dispose();
    } catch (error) {
      console.warn(`[lousho studio] disposing workspace '${ctx.ref.id}' failed:`, error);
    }
  }
}
