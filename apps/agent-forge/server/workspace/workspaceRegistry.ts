/**
 * WorkspaceRegistry - the Studio-global list of project folders
 * ("workspaces") Studio knows about, persisted as `workspaces.json` at
 * `studioPaths().workspaces`. The launch folder is `ensure`d on every
 * start; "Add workspace → folder path" is `add`. Requests still resolve
 * to the launch workspace alone (singleWorkspace) - the registry is what
 * the switcher, the Settings card and the aggregate list read to offer
 * the others.
 *
 * Duplicates are always judged by workspace id (`workspaceIdFor`), never
 * by the raw path string, so `B`, `B/` and a differently-cased Windows
 * drive letter all name the same folder. Every read-modify-write runs
 * inside `withAgentLock('workspaces:registry')` and writes through
 * `writeJsonAtomic`, so two parallel adds both land and a reader only
 * ever sees a complete file. Per-request facts (isLaunch, available,
 * agentCount) are never stored - the routes compute them.
 */
import { promises as fsPromises } from 'node:fs';
import * as path from 'node:path';
import type { WorkspaceRef } from '../../shared/workspace';
import { readJsonFile, withAgentLock, writeJsonAtomic } from '../storage/atomic';
import { workspaceIdFor, workspaceRefFor } from './workspaceId';

/** The `workspaces.json` document on disk. */
// fallow-ignore-next-line unused-type -- part of the registry's file contract; used by readRefs/writeRefs inside this module
export interface WorkspacesFile {
  schemaVersion: 1;
  workspaces: WorkspaceRef[];
}

/** The in-process mutex key serializing every registry read-modify-write (the `workspaces:` prefix keeps it off the agent-id namespace). */
const REGISTRY_LOCK = 'workspaces:registry';

/** The error codes a `WorkspaceRootError` can carry - one per `add()` validation rule. */
export type WorkspaceRootErrorCode =
  | 'LOUSHO_WORKSPACE_ROOT_INVALID'
  | 'LOUSHO_WORKSPACE_ROOT_MISSING'
  | 'LOUSHO_WORKSPACE_ROOT_NOT_DIR';

/** `add()`'s folder validation failed; the route answers `status` with `{ error: message, code }`. */
export class WorkspaceRootError extends Error {
  constructor(
    message: string,
    readonly code: WorkspaceRootErrorCode,
    readonly status: 400 = 400
  ) {
    super(message);
    this.name = 'WorkspaceRootError';
  }
}

/** `add()` named a folder already in the registry (same workspace id) - the route answers 409 naming the existing entry. */
export class WorkspaceExistsError extends Error {
  // fallow-ignore-next-line unused-class-member -- read as error.code under instanceof narrowing in workspaceRoutes.ts, which fallow's import graph does not register
  readonly code = 'LOUSHO_WORKSPACE_EXISTS';
  constructor(readonly existing: WorkspaceRef) {
    super(`'${existing.name}' is already in Studio.`);
    this.name = 'WorkspaceExistsError';
  }
}

/** A route tried to remove the launch workspace; it stays in the list while Studio runs (409). */
export class WorkspaceInUseError extends Error {
  readonly code = 'LOUSHO_WORKSPACE_IN_USE';
  constructor() {
    super('Studio was started in this folder, so it stays in the list while Studio runs.');
    this.name = 'WorkspaceInUseError';
  }
}

/**
 * The workspace list over `file`. `now` is injectable for tests;
 * every public write operation takes the registry lock so its
 * read-modify-write can't interleave with another caller's.
 */
export class WorkspaceRegistry {
  constructor(
    private readonly file: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  /**
   * The stored refs, `[]` when the file is missing. A file that exists
   * but won't parse (or isn't a workspaces file) also reads as `[]`,
   * with one `console.warn` - a corrupt registry must not take down the
   * whole server, and the next write replaces it anyway.
   */
  private async readRefs(): Promise<WorkspaceRef[]> {
    try {
      const stored = await readJsonFile<WorkspacesFile>(this.file);
      if (stored === undefined) return [];
      if (!Array.isArray(stored.workspaces)) throw new Error('not a workspaces file');
      return stored.workspaces;
    } catch (error) {
      console.warn(`[agent-forge] ignoring unreadable workspace registry ${this.file}: ${(error as Error).message}`);
      return [];
    }
  }

  private writeRefs(workspaces: WorkspaceRef[]): Promise<void> {
    const file: WorkspacesFile = { schemaVersion: 1, workspaces };
    return writeJsonAtomic(this.file, file);
  }

  /** Every registered workspace, in file order. */
  list(): Promise<WorkspaceRef[]> {
    return this.readRefs();
  }

  /** The ref for `id`, or `undefined` when it isn't registered. */
  async get(id: string): Promise<WorkspaceRef | undefined> {
    return (await this.readRefs()).find((ref) => ref.id === id);
  }

  /**
   * Adds `root`'s folder when it isn't listed, else just bumps its
   * `lastOpenedAt` - the launch-folder call on every Studio start, which
   * must never throw for an already-registered folder.
   */
  ensure(root: string): Promise<WorkspaceRef> {
    return withAgentLock(REGISTRY_LOCK, async () => {
      const refs = await this.readRefs();
      const id = workspaceIdFor(root);
      const existing = refs.find((ref) => ref.id === id);
      if (existing) {
        existing.lastOpenedAt = this.now().toISOString();
        await this.writeRefs(refs);
        return existing;
      }
      const ref = workspaceRefFor(root, this.now());
      refs.push(ref);
      await this.writeRefs(refs);
      return ref;
    });
  }

  /**
   * Validates `root` and appends its workspace: it must be a non-empty
   * absolute path that exists on disk and is a directory, whose id isn't
   * already registered. Throws {@link WorkspaceRootError} (400) or
   * {@link WorkspaceExistsError} (409) - the route maps them.
   */
  async add(root: string): Promise<WorkspaceRef> {
    const trimmed = typeof root === 'string' ? root.trim() : '';
    if (!trimmed || !path.isAbsolute(trimmed)) {
      throw new WorkspaceRootError(
        'Folder path must be an absolute path, like /home/me/project or C:\\code\\project.',
        'LOUSHO_WORKSPACE_ROOT_INVALID'
      );
    }
    let stat;
    try {
      stat = await fsPromises.stat(trimmed);
    } catch {
      throw new WorkspaceRootError(`No folder at '${trimmed}'.`, 'LOUSHO_WORKSPACE_ROOT_MISSING');
    }
    if (!stat.isDirectory()) {
      throw new WorkspaceRootError(`'${trimmed}' is a file, not a folder.`, 'LOUSHO_WORKSPACE_ROOT_NOT_DIR');
    }
    return withAgentLock(REGISTRY_LOCK, async () => {
      const refs = await this.readRefs();
      const existing = refs.find((ref) => ref.id === workspaceIdFor(trimmed));
      if (existing) throw new WorkspaceExistsError(existing);
      const ref = workspaceRefFor(trimmed, this.now());
      refs.push(ref);
      await this.writeRefs(refs);
      return ref;
    });
  }

  /** Removes `id`'s entry only - never touches files in the folder. `false` when it wasn't listed. */
  remove(id: string): Promise<boolean> {
    return withAgentLock(REGISTRY_LOCK, async () => {
      const refs = await this.readRefs();
      const next = refs.filter((ref) => ref.id !== id);
      if (next.length === refs.length) return false;
      await this.writeRefs(next);
      return true;
    });
  }

  /** `lastOpenedAt = now` for `id`; a no-op when it isn't registered. */
  touch(id: string): Promise<void> {
    return withAgentLock(REGISTRY_LOCK, async () => {
      const refs = await this.readRefs();
      const ref = refs.find((r) => r.id === id);
      if (!ref) return;
      ref.lastOpenedAt = this.now().toISOString();
      await this.writeRefs(refs);
    });
  }
}
