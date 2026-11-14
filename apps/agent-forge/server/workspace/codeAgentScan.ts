/**
 * Code-agent pattern scan + per-app cache (W08a).
 *
 * Where X06a's `findAgentDirs` walks the whole workspace breadth-first,
 * this scan only looks where the workspace's `agentDirs` glob patterns
 * point (the `DEFAULT_AGENT_DIRS` folders by default). A pattern is
 * POSIX segments; `*` matches exactly
 * one directory name; a trailing `/` is optional. `**`, `..` and absolute
 * paths are rejected by {@link isAgentDirPattern} before anything touches
 * the filesystem.
 *
 * Both scans share the X06a helpers (`agentConfigFile`,
 * `describeAgentDir`, `agentDirSkipped`, `AGENT_DIR_LIMIT`) so the
 * `/workspace/agent-dirs` list, the scan routes and the aggregate agent
 * list always agree on what an agent directory is.
 *
 * `CodeAgentCache` is the app's one in-memory scan store: `GET
 * /workspaces/:ws/scan` serves the cached result (scanning first when
 * cold), `POST` rescans with new patterns, and `GET /agents?ws=all`
 * reads `get()`/`scan()` per workspace. Concurrent scans of one
 * workspace share a single promise.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  AGENT_DIR_LIMIT,
  agentConfigFile,
  agentDirSkipped,
  describeAgentDir,
  type DirentLike,
} from './agentDirs';
import type { WorkspaceEntry } from './workspaceRegistry';
import { DEFAULT_AGENT_DIRS, type CodeAgentDir, type WorkspaceScanResult } from '../../shared/wireTypes';

/** `*` is the only wildcard a pattern segment may be - anything else containing `*` (`**`, `a*`) is rejected. */
const WILDCARD = '*';

/**
 * Whether `p` is a valid agent-dir glob: non-empty POSIX segments,
 * relative (no leading `/`, no drive letter), no `..`, and every `*`
 * standing alone as a whole segment. A single trailing `/` is allowed.
 */
export function isAgentDirPattern(p: string): boolean {
  if (typeof p !== 'string') return false;
  const trimmed = p.endsWith('/') ? p.slice(0, -1) : p;
  if (trimmed === '' || trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed)) return false;
  return trimmed.split('/').every((seg) => seg !== '' && seg !== '..' && (seg === WILDCARD || !seg.includes('*')));
}

/** `rel` (POSIX, relative to `root`) for an absolute dir under it. */
function relPosix(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

/** Real subdirectories of `abs` - never links, skips or hidden names (same rule as the BFS scan). */
async function subdirs(abs: string): Promise<DirentLike[]> {
  try {
    const entries = (await fs.readdir(abs, { withFileTypes: true })) as unknown as DirentLike[];
    return entries.filter((e) => e.isDirectory() && !e.isSymbolicLink() && !agentDirSkipped(e.name));
  } catch {
    return [];
  }
}

interface ScanDir {
  abs: string;
}

/** `*` expansion: every qualifying child of each current dir. */
async function expandWildcard(dirs: ScanDir[]): Promise<ScanDir[]> {
  const next: ScanDir[] = [];
  for (const dir of dirs) {
    for (const entry of await subdirs(dir.abs)) {
      next.push({ abs: path.join(dir.abs, entry.name) });
    }
  }
  return next;
}

/** Literal expansion: the named child, only when it is a real non-symlinked directory. */
async function expandLiteral(dirs: ScanDir[], segment: string): Promise<ScanDir[]> {
  const next: ScanDir[] = [];
  for (const dir of dirs) {
    const abs = path.join(dir.abs, segment);
    const stat = await fs.lstat(abs).catch(() => undefined);
    // lstat, not stat: a symlinked dir is never descended into.
    if (stat?.isDirectory() === true && !stat.isSymbolicLink()) {
      next.push({ abs });
    }
  }
  return next;
}

/** The directories one pattern names, before the agent-config check. */
async function expandPattern(root: string, segments: string[]): Promise<ScanDir[]> {
  let dirs: ScanDir[] = [{ abs: root }];
  for (const segment of segments) {
    dirs = segment === WILDCARD ? await expandWildcard(dirs) : await expandLiteral(dirs, segment);
    if (dirs.length === 0) break;
  }
  return dirs;
}

/** Every directory `patterns` names (deduped by absolute path, capped while collecting). */
async function patternCandidates(root: string, patterns: string[]): Promise<ScanDir[]> {
  const candidates = new Map<string, ScanDir>();
  for (const pattern of patterns) {
    const segments = (pattern.endsWith('/') ? pattern.slice(0, -1) : pattern).split('/');
    for (const dir of await expandPattern(root, segments)) {
      if (!candidates.has(dir.abs)) candidates.set(dir.abs, dir);
    }
    if (candidates.size >= AGENT_DIR_LIMIT) break;
  }
  return [...candidates.values()].sort((a, b) => a.abs.localeCompare(b.abs));
}

/** The agent dirs among `candidates`, sorted by POSIX `path`, capped at {@link AGENT_DIR_LIMIT}. */
async function agentDirsAmong(root: string, candidates: ScanDir[]): Promise<CodeAgentDir[]> {
  const found: CodeAgentDir[] = [];
  for (const { abs } of candidates) {
    if (found.length >= AGENT_DIR_LIMIT) break;
    const configFile = await agentConfigFile(abs);
    const rel = relPosix(root, abs) || '.';
    if (configFile !== undefined) found.push(describeAgentDir(root, abs, rel, configFile));
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Every directory `patterns` names that holds an `agent.*` config file,
 * deduped across patterns, sorted by POSIX `path`, capped at
 * {@link AGENT_DIR_LIMIT}. Unreadable directories simply yield nothing.
 */
export async function scanAgentDirs(root: string, patterns: string[]): Promise<CodeAgentDir[]> {
  return agentDirsAmong(root, await patternCandidates(root, patterns));
}

interface CacheEntry {
  result?: WorkspaceScanResult;
  pending?: Promise<WorkspaceScanResult>;
}

/**
 * The app's one code-agent scan cache, keyed by workspace id. `scan()`
 * stores its result; concurrent calls for the same workspace share the
 * in-flight promise so a burst of aggregate/list requests scans once.
 * `forget()` drops the entry (workspace removal).
 */
export class CodeAgentCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** The last scan result for `workspaceId`, or `undefined` when never scanned / forgotten. */
  get(workspaceId: string): WorkspaceScanResult | undefined {
    return this.entries.get(workspaceId)?.result;
  }

  /**
   * Scans `ref.root` and stores the result - always fresh (callers that
   * want the cache check `get()` first; `POST /workspaces/:ws/scan`
   * relies on this rescanning after `agentDirs` change). Uses the
   * entry's stored `agentDirs` patterns, else `DEFAULT_AGENT_DIRS`.
   * Concurrent scans of one workspace share the in-flight promise.
   */
  scan(ref: WorkspaceEntry): Promise<WorkspaceScanResult> {
    const existing = this.entries.get(ref.id);
    if (existing?.pending !== undefined) return existing.pending;
    const pending = (async () => {
      const patterns = [...(ref.agentDirs ?? DEFAULT_AGENT_DIRS)];
      const agents = await scanAgentDirs(ref.root, patterns);
      const result: WorkspaceScanResult = {
        workspaceId: ref.id,
        scannedAt: this.now().toISOString(),
        patterns,
        agents,
      };
      this.entries.set(ref.id, { result });
      return result;
    })();
    this.entries.set(ref.id, { pending });
    return pending.finally(() => {
      const entry = this.entries.get(ref.id);
      if (entry?.pending === pending) entry.pending = undefined;
    });
  }

  /** Drops `workspaceId`'s cached scan (called on `DELETE /workspaces/:ws`). */
  forget(workspaceId: string): void {
    this.entries.delete(workspaceId);
  }
}
