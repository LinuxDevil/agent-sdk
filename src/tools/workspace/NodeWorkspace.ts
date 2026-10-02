/**
 * NodeWorkspace: a Workspace over a real directory (LOU-X6).
 */
import { promises as fsp, realpathSync, statSync, type Dirent, type Stats } from 'node:fs';
import * as nodePath from 'node:path';
import type {
  ShellExecOptions,
  ShellExecResult,
  Workspace,
  WorkspaceDirEntry,
  WorkspaceEntryType,
  WorkspaceStat,
} from './types';
import { normalizeWorkspacePath, WorkspaceError } from './paths';
import { runShellCommand } from './nodeProcess';
import { commandEnv } from '../../security/commandEnv';
import { ConfigurationError } from '../../execution/errors';

const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

/** Options for {@link NodeWorkspace}. */
export interface NodeWorkspaceOptions {
  /** The directory every path is confined to. Must exist. Relative paths resolve against `process.cwd()`. */
  root: string;
  /**
   * Extra environment variables for every command (on top of the allow-listed
   * host variables). Use this - never the host env - to give commands a token.
   */
  env?: Record<string, string>;
  /**
   * Names of additional host environment variables to pass through, e.g.
   * `['NODE_OPTIONS', 'CI']`. By default only `PATH`, `HOME`, `USERPROFILE`,
   * `TEMP`, `TMP`, `TMPDIR`, `LANG`, `LC_*` and `TERM` (plus `SystemRoot`,
   * `SystemDrive`, `ComSpec`, `PATHEXT` and `WINDIR` on Windows) are
   * inherited. `true` passes the whole host environment, API keys included
   * (the behavior before LOU-X11); only use it for trusted commands.
   */
  inheritEnv?: readonly string[] | true;
  /** Shell used to run commands. Defaults to `/bin/sh`, or `%ComSpec%` (cmd.exe) on Windows. */
  shell?: string;
  /** Per-stream cap on captured output in bytes; the middle is dropped beyond it. Defaults to 1,000,000. */
  maxOutputBytes?: number;
}

const FS_ERROR_MESSAGES: Record<string, (path: string) => string> = {
  ENOENT: (p) => `File not found: ${p}`,
  EISDIR: (p) => `${p} is a directory, not a file.`,
  ENOTDIR: (p) => `${p} is not a directory (or a parent of it is a file).`,
  ENOTEMPTY: (p) => `Directory ${p} is not empty; pass { recursive: true } to remove it.`,
  EEXIST: (p) => `${p} already exists.`,
  EACCES: (p) => `Permission denied: ${p}`,
  EPERM: (p) => `Operation not permitted: ${p}`,
};

/** Maps a Node fs error to a WorkspaceError naming the workspace path, never the host path. */
function toWorkspaceError(error: unknown, path: string): WorkspaceError {
  if (error instanceof WorkspaceError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? '';
  const message = FS_ERROR_MESSAGES[code];
  return new WorkspaceError(message ? message(path) : `${code || 'Error'} while accessing ${path}`);
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function entryType(entry: Dirent | Stats): WorkspaceEntryType {
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isDirectory()) return 'directory';
  return entry.isFile() ? 'file' : 'other';
}

function defaultShell(): string {
  return process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh';
}

/** The real path of an existing root directory, or a descriptive error. */
function resolveRoot(root: string | undefined): string {
  if (typeof root !== 'string' || root === '') {
    throw new ConfigurationError("NodeWorkspace: 'root' is required. Example: new NodeWorkspace({ root: './project' })", 'root');
  }
  let real: string;
  try {
    real = realpathSync.native(nodePath.resolve(root));
  } catch {
    throw new ConfigurationError(`NodeWorkspace: root directory ${JSON.stringify(root)} does not exist. Create it first or pass an existing directory.`, 'root');
  }
  if (!statSync(real).isDirectory()) {
    throw new ConfigurationError(`NodeWorkspace: root ${JSON.stringify(root)} is a file, not a directory.`, 'root');
  }
  return real;
}

/**
 * A {@link Workspace} over a real directory: `node:fs` for files and
 * `node:child_process` for commands, with every path confined to `root`.
 *
 * Confinement: each path is normalized (no absolute, UNC or drive-letter
 * paths, no `..` above the root), then resolved with `realpath` on its
 * deepest existing ancestor, so a symlink inside the root that points
 * outside it is rejected - including for files that do not exist yet.
 * Violations reject with a `WorkspaceError`.
 *
 * Commands run with `cwd` = root and a minimal environment (see
 * {@link NodeWorkspaceOptions.inheritEnv}). The shell is NOT a sandbox: a
 * command can read and write anything the OS user can. Give untrusted
 * agents a sandbox-backed `ShellProvider` (e.g. `SandboxShell`) instead.
 *
 * @example
 * ```ts
 * import { NodeWorkspace, createFsTools, createShellTool } from '@lousho/build-ai-agent';
 * const workspace = new NodeWorkspace({ root: '.' });
 * const tools = [...createFsTools(workspace), createShellTool(workspace)];
 * ```
 */
export class NodeWorkspace implements Workspace {
  /** The real, absolute path of the root directory. */
  readonly root: string;
  private readonly env: Record<string, string>;
  private readonly shell: string;
  private readonly maxOutputBytes: number;

  constructor(options: NodeWorkspaceOptions) {
    this.root = resolveRoot(options?.root);
    this.env = commandEnv({ env: options.env, inheritEnv: options.inheritEnv });
    this.shell = options.shell ?? defaultShell();
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  async readFile(path: string): Promise<string> {
    const { rel, abs } = await this.resolve(path);
    return fsp.readFile(abs, 'utf8').catch((error) => Promise.reject(toWorkspaceError(error, rel)));
  }

  async writeFile(path: string, content: string): Promise<void> {
    const { rel, abs } = await this.resolve(path);
    if (abs === this.root) throw new WorkspaceError('Cannot write a file at the workspace root path ".".');
    try {
      await fsp.mkdir(nodePath.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, content, 'utf8');
    } catch (error) {
      throw toWorkspaceError(error, rel);
    }
  }

  async stat(path: string): Promise<WorkspaceStat | undefined> {
    const { rel, abs } = await this.resolve(path);
    try {
      const stats = await fsp.stat(abs);
      return { type: entryType(stats), size: stats.size };
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw toWorkspaceError(error, rel);
    }
  }

  async readdir(path: string): Promise<WorkspaceDirEntry[]> {
    const { rel, abs } = await this.resolve(path);
    try {
      const entries = await fsp.readdir(abs, { withFileTypes: true });
      return entries.map((entry) => ({ name: entry.name, type: entryType(entry) }));
    } catch (error) {
      throw toWorkspaceError(error, rel);
    }
  }

  async mkdir(path: string): Promise<void> {
    const { rel, abs } = await this.resolve(path);
    await fsp.mkdir(abs, { recursive: true }).catch((error) => Promise.reject(toWorkspaceError(error, rel)));
  }

  /** Removes a file or directory. A symlink is removed itself; its target is never touched. */
  async rm(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const { rel, abs } = await this.resolve(path, { followFinalLink: false });
    if (abs === this.root) throw new WorkspaceError('Refusing to remove the workspace root.');
    try {
      const stats = await fsp.lstat(abs);
      if (stats.isDirectory() && !options.recursive) await fsp.rmdir(abs);
      else await fsp.rm(abs, { recursive: options.recursive === true });
    } catch (error) {
      throw toWorkspaceError(error, rel);
    }
  }

  /**
   * Runs `command` in the workspace (`options.cwd` is relative to the root
   * and confined like any path) with the minimal environment plus
   * `options.env`. Timeout and abort kill the whole process tree.
   */
  async exec(command: string, options: ShellExecOptions = {}): Promise<ShellExecResult> {
    const cwd = options.cwd === undefined ? this.root : (await this.resolve(options.cwd)).abs;
    const cwdStat = await fsp.stat(cwd).catch(() => undefined);
    if (!cwdStat?.isDirectory()) {
      throw new WorkspaceError(`Working directory ${JSON.stringify(options.cwd)} does not exist or is not a directory.`);
    }
    return runShellCommand(command, {
      shell: this.shell,
      cwd,
      env: { ...this.env, ...options.env },
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      maxOutputBytes: this.maxOutputBytes,
    });
  }

  /**
   * Validates `path` and returns its real absolute location inside the root.
   * With `followFinalLink: false` the last segment is not dereferenced (so
   * `rm` deletes a link rather than its target).
   */
  private async resolve(path: string, { followFinalLink = true } = {}): Promise<{ rel: string; abs: string }> {
    const rel = normalizeWorkspacePath(path);
    const lexical = rel === '.' ? this.root : nodePath.join(this.root, ...rel.split('/'));
    const abs =
      followFinalLink || rel === '.'
        ? await this.realpathOfDeepestAncestor(lexical, rel)
        : nodePath.join(await this.realpathOfDeepestAncestor(nodePath.dirname(lexical), rel), nodePath.basename(lexical));
    this.assertInside(abs, path);
    return { rel, abs };
  }

  /**
   * `realpath` of `target` when it exists; otherwise the realpath of its
   * deepest existing ancestor joined with the missing tail. A dangling
   * symlink on the way is refused: following it on write could create a
   * file outside the root.
   */
  private async realpathOfDeepestAncestor(target: string, rel: string): Promise<string> {
    try {
      return await fsp.realpath(target);
    } catch (error) {
      if (!isMissing(error)) throw toWorkspaceError(error, rel);
    }
    const linkStat = await fsp.lstat(target).catch(() => undefined);
    if (linkStat?.isSymbolicLink()) {
      throw new WorkspaceError(`Path ${JSON.stringify(rel)} goes through a symlink whose target does not exist; refusing to follow it.`);
    }
    const parent = nodePath.dirname(target);
    if (parent === target) throw new WorkspaceError(`Path ${JSON.stringify(rel)} could not be resolved.`);
    return nodePath.join(await this.realpathOfDeepestAncestor(parent, rel), nodePath.basename(target));
  }

  private assertInside(abs: string, original: string): void {
    const relative = nodePath.relative(this.root, abs);
    const escapes = relative === '..' || relative.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(relative);
    if (escapes) {
      throw new WorkspaceError(
        `Path ${JSON.stringify(original)} resolves outside the workspace (through a symlink). Only paths inside the workspace root are allowed.`
      );
    }
  }
}
