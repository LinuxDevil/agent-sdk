/**
 * Code-agent discovery (X06a): find agent directories under a workspace
 * root - folders holding an `agent.*` config file, whether the config is
 * data (`agent.json`/`agent.yaml`, readable via `agentDirToSpec`) or code
 * (`agent.ts`/`agent.js`, listed but not spec-readable).
 *
 * The scan is breadth-first to {@link AGENT_DIR_SCAN_DEPTH}, skips
 * dependency/build/hidden directories, never follows symlinks, and caps
 * at {@link AGENT_DIR_LIMIT} results. `resolveAgentDir` is the route-side
 * guard that keeps `?path=` inside the workspace and inside the listed
 * set.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { CodeAgentDir } from '../../shared/wireTypes';

/** How deep below the workspace root agent directories are discovered. */
export const AGENT_DIR_SCAN_DEPTH = 3;
/** Directory names never descended into (dependencies, build output, Studio's own state). */
export const AGENT_DIR_SKIP = ['node_modules', '.git', '.lousho', 'dist', 'dist-server', 'build', '.claude', 'coverage'];
/** Cap on listed agent directories - a pathological monorepo cannot stall the route. */
export const AGENT_DIR_LIMIT = 200;

/**
 * Config file names, in precedence order - mirrors `CONFIG_FILES` in
 * `src/agentDir/readConfig.ts` (not exported from the package root, so the
 * list is kept here; keep the two in sync).
 */
const CONFIG_FILES = ['agent.ts', 'agent.mts', 'agent.js', 'agent.mjs', 'agent.cjs', 'agent.json', 'agent.yaml', 'agent.yml'] as const;
const CODE_CONFIG = /\.(?:ts|mts|js|mjs|cjs)$/;

export interface DirentLike {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/** The config file `entries` holds, in `CONFIG_FILES` precedence order. */
function configFileIn(entries: DirentLike[]): string | undefined {
  const files = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
  return CONFIG_FILES.find((name) => files.has(name));
}

function toPosix(rel: string): string {
  return rel.split(path.sep).join('/');
}

/**
 * Whether `name` is a directory the agent-dir scans never descend into:
 * the {@link AGENT_DIR_SKIP} names plus dot-directories. Shared by the
 * X06a breadth-first scan and the W08a pattern scan so both agree on
 * what counts as skippable.
 */
export function agentDirSkipped(name: string): boolean {
  return AGENT_DIR_SKIP.includes(name) || name.startsWith('.');
}

function skipped(name: string): boolean {
  return agentDirSkipped(name);
}

/** `readdir` that tolerates unreadable/vanished dirs by answering `undefined`. */
async function readDirEntries(abs: string): Promise<DirentLike[] | undefined> {
  try {
    return (await fs.readdir(abs, { withFileTypes: true })) as unknown as DirentLike[];
  } catch {
    return undefined;
  }
}

/** Real subdirectories worth descending into - never links, skips or hidden names. */
function subdirsOf(entries: DirentLike[]): DirentLike[] {
  return entries.filter((e) => e.isDirectory() && !e.isSymbolicLink() && !skipped(e.name));
}

function childRel(rel: string, name: string): string {
  return rel === '.' ? name : `${rel}/${name}`;
}

/**
 * The `CodeAgentDir` row for one found agent directory - shared by the
 * X06a breadth-first scan and the W08a pattern scan so `path`/`name`/
 * `configKind` are computed identically.
 */
export function describeAgentDir(baseDir: string, abs: string, rel: string, configFile: string): CodeAgentDir {
  return {
    path: toPosix(rel),
    name: rel === '.' ? path.basename(baseDir) : path.basename(abs),
    configFile,
    configKind: CODE_CONFIG.test(configFile) ? 'code' : 'data',
  };
}

/**
 * Every directory at or under `baseDir` (depth 0..{@link AGENT_DIR_SCAN_DEPTH})
 * that contains an `agent.*` config file, sorted by `path`. `baseDir` itself
 * counts as depth 0 and is always scanned, even when its own name is hidden
 * or skipped - it is the workspace the user opened, not a candidate child.
 */
export async function findAgentDirs(baseDir: string): Promise<CodeAgentDir[]> {
  const found: CodeAgentDir[] = [];
  const queue: Array<{ abs: string; rel: string; depth: number }> = [{ abs: baseDir, rel: '.', depth: 0 }];
  while (queue.length > 0 && found.length < AGENT_DIR_LIMIT) {
    const { abs, rel, depth } = queue.shift()!;
    const entries = await readDirEntries(abs);
    if (entries === undefined) continue;
    const configFile = configFileIn(entries);
    if (configFile !== undefined) found.push(describeAgentDir(baseDir, abs, rel, configFile));
    if (depth >= AGENT_DIR_SCAN_DEPTH) continue;
    for (const entry of subdirsOf(entries)) {
      queue.push({ abs: path.join(abs, entry.name), rel: childRel(rel, entry.name), depth: depth + 1 });
    }
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The agent config file `dir` holds (in `CONFIG_FILES` precedence order),
 * or `undefined` when it has none - also `undefined` when `dir` cannot be
 * read. Used by the scan, `resolveAgentDir` and the spec route's cache key.
 */
export async function agentConfigFile(dir: string): Promise<string | undefined> {
  try {
    const entries = (await fs.readdir(dir, { withFileTypes: true })) as unknown as DirentLike[];
    return configFileIn(entries);
  } catch {
    return undefined;
  }
}

/**
 * Resolves a client-supplied `rel` (POSIX separators, relative to `baseDir`)
 * to an absolute agent-directory path, or `undefined` when it escapes
 * `baseDir` (`..`, absolute paths, symlinks pointing outside) or is not a
 * directory with an agent config file. Both sides are realpath'd so a
 * symlinked parent cannot smuggle the scan outside the workspace.
 */
export async function resolveAgentDir(baseDir: string, rel: string): Promise<string | undefined> {
  if (rel === '' || path.isAbsolute(rel) || path.win32.isAbsolute(rel)) return undefined;
  // Accept both separators: on Windows a '\\' would otherwise slip past the
  // '..' check and still resolve as a parent traversal.
  const segments = rel.split(/[\\/]/);
  if (segments.some((s) => s === '..' || s === '')) return undefined;
  const candidate = path.resolve(baseDir, ...segments);
  const [realBase, realCandidate] = await Promise.all([
    fs.realpath(baseDir).catch(() => path.resolve(baseDir)),
    fs.realpath(candidate).catch(() => undefined),
  ]);
  if (realCandidate === undefined) return undefined;
  const inside = realCandidate === realBase || realCandidate.startsWith(realBase + path.sep);
  if (!inside) return undefined;
  return (await agentConfigFile(realCandidate)) !== undefined ? realCandidate : undefined;
}
