/**
 * MemoryWorkspace: an in-memory Workspace for tests and demos (LOU-X6).
 */
import type {
  ShellExecOptions,
  ShellExecResult,
  Workspace,
  WorkspaceDirEntry,
  WorkspaceStat,
} from './types';
import { normalizeWorkspacePath, parentWorkspacePath, WorkspaceError } from './paths';

/** A scripted reply for {@link MemoryWorkspace.exec}; missing fields default to success. */
export type MemoryExecReply = Partial<ShellExecResult>;

/** Programs {@link MemoryWorkspace.exec}: receives each command and returns (or resolves) its result. */
export type MemoryExecHandler = (
  command: string,
  options: ShellExecOptions
) => MemoryExecReply | Promise<MemoryExecReply>;

/** Options for {@link MemoryWorkspace}. */
export interface MemoryWorkspaceOptions {
  /** Initial files, keyed by workspace-relative path. Parent directories are created. */
  files?: Record<string, string>;
  /** Scripted shell. Without it every command fails with exit code 127. */
  exec?: MemoryExecHandler;
}

/** A command recorded by {@link MemoryWorkspace.exec}. */
export interface MemoryExecCall {
  command: string;
  options: ShellExecOptions;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * An in-memory {@link Workspace}: a file tree held in a `Map` plus a
 * scripted, programmable `exec`. Paths are validated exactly like
 * `NodeWorkspace` validates them (no `..` escapes, no absolute paths), so
 * tests written against it exercise the same rejections.
 *
 * @example
 * ```ts
 * import { MemoryWorkspace } from '@loushy/build-ai-agent';
 * const ws = new MemoryWorkspace({
 *   files: { 'src/a.ts': 'export const a = 1;\n' },
 *   exec: (command) => (command === 'npm test' ? { stdout: 'ok\n' } : { exitCode: 1, stderr: 'unknown\n' }),
 * });
 * await ws.writeFile('src/b.ts', 'export const b = 2;\n');
 * const result = await ws.exec('npm test'); // { stdout: 'ok\n', exitCode: 0, ... }
 * console.log(ws.commands.map((c) => c.command)); // ['npm test']
 * ```
 */
export class MemoryWorkspace implements Workspace {
  private readonly files = new Map<string, string>();
  private readonly dirs = new Set<string>(['.']);
  private readonly handler?: MemoryExecHandler;
  /** Every command passed to `exec`, in order. */
  readonly commands: MemoryExecCall[] = [];

  constructor(options: MemoryWorkspaceOptions = {}) {
    this.handler = options.exec;
    for (const [path, content] of Object.entries(options.files ?? {})) {
      this.put(normalizeWorkspacePath(path), content);
    }
  }

  /** A snapshot of every file, keyed by normalized path (handy for assertions). */
  snapshot(): Record<string, string> {
    return Object.fromEntries([...this.files.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  }

  async readFile(path: string): Promise<string> {
    const key = normalizeWorkspacePath(path);
    const content = this.files.get(key);
    if (content !== undefined) return content;
    throw new WorkspaceError(this.dirs.has(key) ? `${key} is a directory, not a file.` : `File not found: ${key}`);
  }

  async writeFile(path: string, content: string): Promise<void> {
    const key = normalizeWorkspacePath(path);
    if (this.dirs.has(key)) throw new WorkspaceError(`${key} is a directory, not a file.`);
    this.put(key, content);
  }

  async stat(path: string): Promise<WorkspaceStat | undefined> {
    const key = normalizeWorkspacePath(path);
    const content = this.files.get(key);
    if (content !== undefined) return { type: 'file', size: byteLength(content) };
    return this.dirs.has(key) ? { type: 'directory', size: 0 } : undefined;
  }

  async readdir(path: string): Promise<WorkspaceDirEntry[]> {
    const key = normalizeWorkspacePath(path);
    if (!this.dirs.has(key)) {
      throw new WorkspaceError(this.files.has(key) ? `${key} is a file, not a directory.` : `Directory not found: ${key}`);
    }
    const entries: WorkspaceDirEntry[] = [];
    for (const dir of this.dirs) {
      if (dir !== '.' && parentWorkspacePath(dir) === key) entries.push({ name: dir.slice(dir.lastIndexOf('/') + 1), type: 'directory' });
    }
    for (const file of this.files.keys()) {
      if (parentWorkspacePath(file) === key) entries.push({ name: file.slice(file.lastIndexOf('/') + 1), type: 'file' });
    }
    return entries;
  }

  async mkdir(path: string): Promise<void> {
    const key = normalizeWorkspacePath(path);
    if (this.files.has(key)) throw new WorkspaceError(`${key} is a file, not a directory.`);
    this.ensureDir(key);
  }

  async rm(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const key = normalizeWorkspacePath(path);
    if (key === '.') throw new WorkspaceError('Refusing to remove the workspace root.');
    if (this.files.delete(key)) return;
    if (!this.dirs.has(key)) throw new WorkspaceError(`Not found: ${key}`);
    const prefix = `${key}/`;
    const children = [...this.files.keys(), ...this.dirs].filter((p) => p.startsWith(prefix));
    if (children.length > 0 && !options.recursive) {
      throw new WorkspaceError(`Directory ${key} is not empty; pass { recursive: true } to remove it.`);
    }
    for (const child of children) {
      this.files.delete(child);
      this.dirs.delete(child);
    }
    this.dirs.delete(key);
  }

  /** Runs the scripted handler (or fails with 127 when none is configured) and records the call. */
  async exec(command: string, options: ShellExecOptions = {}): Promise<ShellExecResult> {
    this.commands.push({ command, options });
    if (!this.handler) {
      return {
        stdout: '',
        stderr: 'MemoryWorkspace: no exec handler configured. Pass new MemoryWorkspace({ exec: (command) => ({ stdout: "..." }) }).\n',
        exitCode: 127,
        timedOut: false,
      };
    }
    const reply = await this.handler(command, options);
    return { stdout: '', stderr: '', exitCode: 0, timedOut: false, ...reply };
  }

  private put(key: string, content: string): void {
    if (key === '.') throw new WorkspaceError('Cannot write a file at the workspace root path ".".');
    this.ensureDir(parentWorkspacePath(key));
    this.files.set(key, content);
  }

  private ensureDir(key: string): void {
    for (let dir = key; !this.dirs.has(dir); dir = parentWorkspacePath(dir)) {
      if (this.files.has(dir)) throw new WorkspaceError(`${dir} is a file, not a directory.`);
      this.dirs.add(dir);
    }
  }
}
