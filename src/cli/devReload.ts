/**
 * What `lousho dev` serves and how it hot-reloads it (LOU-D31).
 *
 * A target is a spec file (.yaml/.yml/.json), an agent directory, or a
 * .ts/.js module whose default (or `agent`) export is a `SimpleAgent` or a
 * `createAgent()` config. {@link startReloader} loads it, watches what it was
 * built from and swaps a rebuilt agent into the shared {@link DevState}.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgent, createAgentConfigOf, type CreateAgentConfig, type SimpleAgent } from '../createAgent';
import { SDKError } from '../execution/errors';
import { resolveAgentDir } from '../agentDir';
import type { Channel } from '../channels/defineChannel';
import { mountChannels, type ChannelsHandler } from '../channels/mountChannels';
import type { DefinedSchedule } from '../schedules/defineSchedule';
import { startSchedules, type RunningSchedules, type StartSchedulesOptions } from '../schedules/startSchedules';
import { explainImportError, forgetCommonJsModules, withFreshImports } from '../agentDir/importModule';
import { memoryStore } from '../storage/agentStore';
import { loadSpec } from '../spec/loadSpec';
import { specToAgent } from '../spec/specToAgent';

export type DevTargetKind = 'spec' | 'dir' | 'module';

export interface DevTarget {
  kind: DevTargetKind;
  /** Absolute path of the spec file, directory or module. */
  path: string;
}

/** What `GET /dev/status` reports and what the chat UI shows. */
export interface DevState {
  agent: SimpleAgent;
  target: DevTarget;
  /** Where `/chat` sessions live (LOU-D32): kept across reloads, so they continue on the new agent. */
  store: ReturnType<typeof memoryStore>;
  /** The agent directory's channels, mounted under `/channels` (LOU-P8.2); undefined when it has none. Replaced on reload. */
  channels?: ChannelsHandler;
  /** Names of the mounted channels that authenticate their requests (`verify`): the dev server's `Host` check skips them. */
  verifiedChannels?: ReadonlySet<string>;
  /** Successful reloads since start. */
  reloads: number;
  /** The last failed reload's message; cleared by the next good one. */
  error?: string;
}

export interface DevOptions {
  /** `createAgent()` options that win over what the target says (e.g. a test provider). */
  overrides?: CreateAgentConfig;
  /** Wait this long after the last file change before reloading. Default 100. */
  debounceMs?: number;
  /** Start an agent directory's `schedules/` (default true); `false` is `--no-schedules`. */
  schedules?: boolean;
  /** Overrides for the scheduler (clock, timers, error sink); mainly for tests. */
  scheduler?: StartSchedulesOptions;
  /** `--allowed-hosts`: host names the `Host` header may carry besides loopback ones (and, off loopback, IP addresses); `'*'` for any. */
  allowedHosts?: string[];
}

/** What a target loads into: the agent and, for an agent directory, its schedules and channels. */
interface LoadedTarget {
  agent: SimpleAgent;
  schedules: DefinedSchedule[];
  channels: Channel[];
}

const SPEC_EXT = new Set(['.yaml', '.yml', '.json']);
const MODULE_EXT = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const RESOLVE_EXT = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'];
const TARGET_HINT = 'Pass an agent spec (.yaml/.yml/.json), an agent directory, or a .ts/.js module that exports an agent.';

function log(message: string): void {
  console.log(`[lousho dev] ${message}`);
}

/** Picks the target kind from the path (`command` names the calling `lousho` command in errors): a directory, a spec by extension, or a module by extension. */
export function detectTarget(rawPath: string, command = 'dev'): DevTarget {
  const file = path.resolve(rawPath);
  const ext = path.extname(file).toLowerCase();
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) return { kind: 'dir', path: file };
  // A missing spec keeps failing inside loadSpec, as it always did.
  if (SPEC_EXT.has(ext)) return { kind: 'spec', path: file };
  if (!fs.existsSync(file)) {
    throw new SDKError(`lousho ${command}: '${rawPath}' does not exist.`, 'LOUSHO_CONFIG_INVALID', { hint: TARGET_HINT });
  }
  if (MODULE_EXT.has(ext)) return { kind: 'module', path: file };
  throw new SDKError(
    `lousho ${command}: unsupported file type '${ext || '(none)'}' for '${rawPath}'.`,
    'LOUSHO_SPEC_UNSUPPORTED_FORMAT',
    { hint: TARGET_HINT }
  );
}

/** Agents built with their own `store` (a config export's, or `overrides.store`): `/chat` sessions use it, not the dev store. */
const storeOwners = new WeakSet<SimpleAgent>();

/** Whether `agent` was configured with a `store` of its own (LOU-D32). */
export function hasOwnStore(agent: SimpleAgent): boolean {
  return storeOwners.has(agent);
}

function isSimpleAgent(value: unknown): value is SimpleAgent {
  const v = value as Partial<SimpleAgent> | null;
  return typeof v === 'object' && v !== null && typeof v.send === 'function' && typeof v.close === 'function';
}

function isAgentConfig(value: unknown): value is CreateAgentConfig {
  return typeof value === 'object' && value !== null && ('instructions' in value || 'prompt' in value);
}

async function loadModuleAgent(file: string, token: string, overrides: CreateAgentConfig): Promise<SimpleAgent> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(`${pathToFileURL(file).href}?t=${token}`)) as Record<string, unknown>;
  } catch (error) {
    throw explainImportError(file, error);
  }
  const exported = mod.default ?? mod.agent;
  if (isSimpleAgent(exported)) {
    // A module can export an already-built agent. Its createAgent() options are
    // remembered by createAgentConfigOf(), so an `overrides.exporter` (--traces)
    // still reaches its runs: the agent is rebuilt with it (an exporter cannot be
    // attached after the fact). An agent not built by createAgent() keeps its own
    // configuration - warn that --traces cannot apply to it.
    const config = createAgentConfigOf(exported);
    if (overrides.exporter === undefined) return exported;
    if (config === undefined) {
      console.warn(
        'lousho: --traces cannot be applied to the agent this module exports (it was not created with createAgent()); its own exporter, if any, is used.'
      );
      return exported;
    }
    const agent = createAgent({ ...config, exporter: overrides.exporter });
    if (config.store) storeOwners.add(agent);
    return agent;
  }
  if (isAgentConfig(exported)) {
    const agent = createAgent({ ...exported, ...overrides } as CreateAgentConfig);
    if (exported.store) storeOwners.add(agent);
    return agent;
  }
  throw new SDKError(
    `lousho dev: ${file} must export a SimpleAgent or a createAgent() config as its default export (or as 'agent').`,
    'LOUSHO_CONFIG_INVALID',
    { hint: "Add 'export default createAgent({ ... })', or export the createAgent() options object." }
  );
}

let loads = 0;

/**
 * Builds the agent a target describes. Directory and module loads import the
 * edited files afresh (`?t=` cache-bust); they also `ready()` the agent so MCP
 * connection errors surface here.
 */
export async function loadTarget(target: DevTarget, options: DevOptions = {}): Promise<SimpleAgent> {
  return (await loadDevTarget(target, options)).agent;
}

async function loadDirTarget(dir: string, overrides: CreateAgentConfig): Promise<LoadedTarget> {
  const { config, schedules, channels } = await resolveAgentDir(dir, overrides);
  return { agent: createAgent(config), schedules, channels };
}

async function loadDevTarget(target: DevTarget, options: DevOptions): Promise<LoadedTarget> {
  const overrides = options.overrides ?? {};
  if (target.kind === 'spec') return { agent: specToAgent(loadSpec(target.path), { exporter: overrides.exporter }), schedules: [], channels: [] };
  const token = `${Date.now()}-${loads++}`;
  const loaded = await withFreshImports(token, async () =>
    target.kind === 'dir'
      ? loadDirTarget(target.path, overrides)
      : { agent: await loadModuleAgent(target.path, token, overrides), schedules: [], channels: [] }
  );
  const { agent } = loaded;
  if (overrides.store) storeOwners.add(agent);
  try {
    await agent.ready();
  } catch (error) {
    await agent.close().catch(() => undefined);
    throw error;
  }
  return loaded;
}

/** Makes `loaded` the live target: its agent, its channels mounted, its schedules started (unless disabled). Returns the schedules to stop on the next swap. */
function activate(state: DevState, loaded: LoadedTarget, options: DevOptions): RunningSchedules | undefined {
  state.agent = loaded.agent;
  state.channels = loaded.channels.length > 0 ? mountChannels(loaded.agent, loaded.channels, { store: state.store }) : undefined;
  state.verifiedChannels = new Set(loaded.channels.filter((channel) => channel.verify).map((channel) => channel.name));
  if (loaded.schedules.length === 0) return undefined;
  const names = loaded.schedules.map((s) => s.name).join(', ');
  if (options.schedules === false) return void log(`schedules not started (--no-schedules): ${names}`);
  log(`started schedules: ${names}`);
  return startSchedules(loaded.agent, loaded.schedules, options.scheduler);
}

const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"]*)['"]/g;

function isFile(file: string): boolean {
  return fs.existsSync(file) && fs.statSync(file).isFile();
}

function resolveImport(from: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(from), specifier);
  // './x.js' written for an './x.ts' source (NodeNext style) is tried too.
  const stems = [base, base.replace(/\.[cm]?js$/, '')];
  const candidates = stems.flatMap((s) => [s, ...RESOLVE_EXT.map((e) => s + e), ...RESOLVE_EXT.map((e) => path.join(s, `index${e}`))]);
  return candidates.find(isFile);
}

/** `entry` plus every file it imports through relative specifiers, walked once (no bundler, no node_modules). */
export function collectLocalImports(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.[cm]?[jt]s$/.test(file)) continue;
    for (const match of fs.readFileSync(file, 'utf8').matchAll(IMPORT_SPECIFIER)) {
      const resolved = resolveImport(file, match[1]);
      if (resolved) queue.push(resolved);
    }
  }
  return [...seen];
}

const IGNORED_SEGMENT = /(^|[\\/])(node_modules|\.git)([\\/]|$)/;

/**
 * Watches every directory of an agent directory, one non-recursive watcher
 * each (subdirectories created later included). Not `recursive: true`: on
 * Linux that watches each file, and a file an editor replaces on save (write
 * to a temp file, then rename) is no longer watched after its first save.
 */
function watchTree(root: string, onChange: (name: string) => void): () => void {
  const watchers = new Map<string, { watcher: fs.FSWatcher; ino: number }>();
  /** Stops watching `dir` and everything below it. */
  const unwatch = (dir: string): void => {
    for (const [watched, { watcher }] of watchers) {
      if (watched === dir || watched.startsWith(dir + path.sep)) {
        watcher.close();
        watchers.delete(watched);
      }
    }
  };
  /** Closes `watcher`, and stops watching `dir` when it is still the one watching it. */
  const drop = (dir: string, watcher: fs.FSWatcher): void => {
    if (watchers.get(dir)?.watcher === watcher) unwatch(dir);
    else watcher.close();
  };
  /** Whether `dir` is still the very directory `watcher` was opened on (not removed, not replaced by a new one). */
  const isCurrent = (dir: string, watcher: fs.FSWatcher): boolean => {
    const entry = watchers.get(dir);
    return entry?.watcher === watcher && fs.statSync(dir, { throwIfNoEntry: false })?.ino === entry.ino;
  };
  /**
   * `dir`'s stats when it is a directory not watched yet. A directory removed and created again
   * (git checkout, a regenerated folder) is a new one: its old watcher is dead (on Linux it gets a
   * 'rename' event, not an error), so it is dropped.
   */
  const unwatched = (dir: string): fs.Stats | undefined => {
    const stat = fs.statSync(dir, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || watchers.get(dir)?.ino === stat.ino) return undefined;
    unwatch(dir);
    return stat;
  };
  const onEvent = (dir: string, watcher: fs.FSWatcher, name: string | null): void => {
    // The directory itself went away: its parent's watcher reports the removal.
    if (!isCurrent(dir, watcher)) return drop(dir, watcher);
    const changed = path.join(dir, name ?? '');
    // A changed entry that is a directory (new, or created again) is watched; anything else is no longer.
    if (fs.statSync(changed, { throwIfNoEntry: false })?.isDirectory()) watchDir(changed);
    else unwatch(changed);
    onChange(path.relative(root, changed));
  };
  const open = (dir: string): fs.FSWatcher | undefined => {
    try {
      const watcher: fs.FSWatcher = fs.watch(dir, { persistent: false }, (_event, name) => onEvent(dir, watcher, name));
      watcher.on('error', () => drop(dir, watcher));
      return watcher;
    } catch {
      return undefined; // removed before it could be watched
    }
  };
  const subdirectories = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
    } catch {
      return []; // removed meanwhile; its watcher is dropped on its next event
    }
  };
  function watchDir(dir: string): void {
    if (IGNORED_SEGMENT.test(path.relative(root, dir))) return;
    const stat = unwatched(dir);
    const watcher = stat && open(dir);
    if (!stat || !watcher) return;
    watchers.set(dir, { watcher, ino: stat.ino });
    subdirectories(dir).forEach(watchDir);
  }
  watchDir(root);
  return () => watchers.forEach(({ watcher }) => watcher.close());
}

/** Watches the target's sources; calls `onChange` with the name that changed (relative to the target's folder). */
function watchTarget(target: DevTarget, onChange: (name: string) => void): () => void {
  if (target.kind === 'dir') return watchTree(target.path, onChange);
  // Watch parent directories: editors replace files on save, which kills a per-file watcher.
  const watchers: fs.FSWatcher[] = [];
  const files = target.kind === 'module' ? collectLocalImports(target.path) : [target.path];
  const wanted = new Set(files);
  const root = path.dirname(target.path);
  for (const dir of new Set(files.map((f) => path.dirname(f)))) {
    watchers.push(
      fs.watch(dir, { persistent: false }, (_event, name) => {
        if (name === null || wanted.has(path.join(dir, name))) onChange(path.relative(root, path.join(dir, name ?? '')));
      })
    );
  }
  return () => watchers.forEach((w) => w.close());
}

export interface DevReloader {
  state: DevState;
  /** Waits for a reload in progress, stops watching and closes the live agent. */
  close: () => Promise<void>;
}

/**
 * Loads `target` and keeps `state.agent` current as its files change
 * (debounced). A reload builds and readies the new agent first, then swaps it
 * in and closes the previous one. If building fails, the last good agent
 * stays, `state.error` is set and the error is logged.
 */
export async function startReloader(target: DevTarget, options: DevOptions = {}): Promise<DevReloader> {
  const first = await loadDevTarget(target, options);
  const state: DevState = { agent: first.agent, target, store: memoryStore(), reloads: 0 };
  let schedules = activate(state, first, options);
  const changed = new Set<string>();
  const name = path.basename(target.path);
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  let closed = false;

  async function reload(): Promise<void> {
    const what = [...changed].filter(Boolean).join(', ') || name;
    // A changed CommonJS helper that a tool file requires is cached by Node apart from the tool file itself.
    const root = target.kind === 'dir' ? target.path : path.dirname(target.path);
    forgetCommonJsModules([...changed].filter(Boolean).map((file) => path.resolve(root, file)));
    changed.clear();
    try {
      const next = await loadDevTarget(target, options);
      if (closed) return void (await next.agent.close());
      const previous = state.agent;
      // The old schedules stop (their timers synchronously; a run in flight finishes on its own) before the new
      // ones start, so a reload never leaves two sets of timers.
      void schedules?.stop();
      schedules = activate(state, next, options);
      state.reloads += 1;
      delete state.error;
      await previous.close().catch(() => undefined);
      log(`reloaded ${name} (changed: ${what})`);
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      console.error(`[lousho dev] failed to reload ${name}, keeping the previous agent: ${state.error}`);
    }
  }

  const stop = watchTarget(target, (changedName) => {
    changed.add(changedName);
    clearTimeout(timer);
    timer = setTimeout(() => {
      running = running.then(reload);
    }, options.debounceMs ?? 100);
  });

  return {
    state,
    close: async () => {
      closed = true;
      clearTimeout(timer);
      stop();
      await running;
      await schedules?.stop();
      await state.agent.close().catch(() => undefined);
    },
  };
}
