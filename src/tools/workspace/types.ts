/**
 * Workspace provider interfaces (LOU-X6).
 *
 * The file system and shell tools (`createFsTools`, `createShellTool`) never
 * touch `node:fs` or `node:child_process` themselves: they talk to these two
 * small interfaces. Implement them to run an agent's tools against any
 * backend - a local directory (`NodeWorkspace`), an in-memory tree
 * (`MemoryWorkspace`), a Docker container (`SandboxShell`), or a remote
 * sandbox such as E2B, Daytona or Cloudflare.
 */

/** The kind of a file system entry. */
export type WorkspaceEntryType = 'file' | 'directory' | 'symlink' | 'other';

/** Result of {@link FsProvider.stat}. */
export interface WorkspaceStat {
  type: WorkspaceEntryType;
  /** Size in bytes (0 for directories when the backend does not report one). */
  size: number;
}

/** One entry returned by {@link FsProvider.readdir}. */
export interface WorkspaceDirEntry {
  /** The entry's name (no directory part). */
  name: string;
  type: WorkspaceEntryType;
}

/**
 * File system access for the workspace tools.
 *
 * Every `path` is a workspace-relative, `/`-separated path such as
 * `'src/index.ts'` or `'.'` for the root. The tools validate paths before
 * calling the provider, but a provider exposed to a model MUST still confine
 * every path to its own root itself - see `NodeWorkspace` for a reference
 * implementation. Methods reject (throw) on failure; the tools turn that into
 * a tool error the model can read, so prefer messages like
 * `"File not found: src/a.ts"` over raw backend errors.
 *
 * @example
 * ```ts
 * import type { FsProvider } from '@lousho/build-ai-agent';
 * const files = new Map<string, string>();
 * const fsProvider: FsProvider = {
 *   async readFile(path) { const c = files.get(path); if (c === undefined) throw new Error(`File not found: ${path}`); return c; },
 *   async writeFile(path, content) { files.set(path, content); },
 *   async stat(path) { return files.has(path) ? { type: 'file', size: files.get(path)!.length } : undefined; },
 *   async readdir() { return [...files.keys()].map((name) => ({ name, type: 'file' as const })); },
 *   async mkdir() {},
 *   async rm(path) { files.delete(path); },
 * };
 * ```
 */
export interface FsProvider {
  /** Read a UTF-8 text file. Rejects when it does not exist or is a directory. */
  readFile(path: string): Promise<string>;
  /** Create or overwrite a UTF-8 text file, creating missing parent directories. */
  writeFile(path: string, content: string): Promise<void>;
  /** Describe an entry, or resolve `undefined` when nothing exists at `path`. */
  stat(path: string): Promise<WorkspaceStat | undefined>;
  /** List a directory's direct children (any order). Rejects when `path` is not a directory. */
  readdir(path: string): Promise<WorkspaceDirEntry[]>;
  /** Create a directory and any missing parents. A no-op when it already exists. */
  mkdir(path: string): Promise<void>;
  /** Remove a file, or a directory when `recursive` is true. */
  rm(path: string, options?: { recursive?: boolean }): Promise<void>;
  /**
   * Optional native glob (e.g. a remote `find`). When omitted, the `glob` and
   * `grep` tools walk the tree with `readdir`. Must return workspace-relative
   * file paths.
   */
  glob?(pattern: string, options?: { signal?: AbortSignal }): Promise<string[]>;
  /**
   * Optional: a file's permission bits (e.g. `0o755`), or `undefined` when
   * nothing exists at `path`. With `chmod`, it lets `WorkspaceCheckpoints`
   * restore a file's mode as well as its content (N7). `NodeWorkspace` has both.
   */
  getMode?(path: string): Promise<number | undefined>;
  /** Optional: set a file's permission bits. See {@link FsProvider.getMode}. */
  chmod?(path: string, mode: number): Promise<void>;
  /**
   * Optional: a file's raw bytes. With it, `edit_file` refuses a file that is
   * not UTF-8 (a latin1 or UTF-16 file) instead of writing it back with
   * U+FFFD in place of every byte it could not decode. `NodeWorkspace` has it.
   */
  readFileBytes?(path: string): Promise<Uint8Array>;
}

/** Options for {@link ShellProvider.exec}. */
export interface ShellExecOptions {
  /** Working directory, relative to the workspace root. Defaults to the root. */
  cwd?: string;
  /** Kill the command (and its children) after this many milliseconds. */
  timeoutMs?: number;
  /** Kill the command (and its children) when this signal aborts. */
  signal?: AbortSignal;
  /** Extra environment variables for this command. */
  env?: Record<string, string>;
}

/** Result of {@link ShellProvider.exec}. */
export interface ShellExecResult {
  stdout: string;
  stderr: string;
  /** The process exit code, or `null` when it was killed (timeout, abort, signal). */
  exitCode: number | null;
  /** True when the command was killed because `timeoutMs` elapsed. */
  timedOut: boolean;
  /** True when the command was killed because `signal` aborted. */
  aborted?: boolean;
}

/**
 * Command execution for the `shell` tool.
 *
 * `exec` runs one shell command line and resolves once it has exited. It
 * resolves (never rejects) for a non-zero exit code, a timeout or an abort;
 * it rejects only when the command could not be started at all.
 *
 * @example
 * ```ts
 * import type { ShellProvider } from '@lousho/build-ai-agent';
 * const echoShell: ShellProvider = {
 *   async exec(command) {
 *     return { stdout: `would run: ${command}\n`, stderr: '', exitCode: 0, timedOut: false };
 *   },
 * };
 * ```
 */
export interface ShellProvider {
  /**
   * The shell binary commands run in, e.g. `'/bin/sh'` or `'C:\\Windows\\system32\\cmd.exe'`.
   * Optional. When set, the `shell` tool names it to the model and applies
   * cmd.exe's extra operators (`%` `^`) to `allow` checks.
   */
  readonly shell?: string;
  exec(command: string, options?: ShellExecOptions): Promise<ShellExecResult>;
}

/** A workspace offers both file system and shell access (e.g. `NodeWorkspace`, `MemoryWorkspace`). */
export type Workspace = FsProvider & ShellProvider;
