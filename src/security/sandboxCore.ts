/**
 * Sandbox adapter interface (LOU-F4) and its trusted-host, zero-isolation
 * implementation NoopSandbox.
 *
 * Split out of sandbox.ts (LOU-I2) so the execution core (AgentExecutor,
 * resume, FlowExecutor, sandboxGuard, types) can depend on the interface and
 * the default NoopSandbox WITHOUT pulling in dockerode (and its native,
 * unbundleable ssh2/cpu-features subtree) - which is what lets `loushy build`
 * bundle a self-contained deployment server. sandbox.ts re-exports
 * everything here, so existing imports of ./sandbox are unaffected.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile as fsWriteFile } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

/**
 * The outcome of running a command through a SandboxAdapter.
 */
export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Options for a single SandboxAdapter.run() call.
 */
export interface SandboxRunOptions {
  /** Working directory to run the command in. */
  cwd?: string;
  /** Environment variables for the command's process. */
  env?: Record<string, string>;
  /** Timeout in milliseconds after which the command is killed. */
  timeoutMs?: number;
  /** Aborts the command (LOU-U17); `run()` then rejects with an `AbortError`. Adapters may ignore it. */
  signal?: AbortSignal;
}

/**
 * A pluggable command-execution backend. Implementations range from "no
 * isolation at all" (NoopSandbox) to a fully isolated container
 * (SubprocessSandbox, LOU-F6).
 */
export interface SandboxAdapter {
  /** A short, human-readable identifier for the adapter (e.g. 'noop', 'docker'). */
  readonly name: string;

  /**
   * Run `cmd` with `args` inside the sandbox and resolve with its
   * stdout/stderr/exitCode once the process exits. Never rejects on a
   * non-zero exit code - only on an actual failure to run the command
   * (e.g. the binary doesn't exist, or the sandbox backend itself errors).
   */
  run(cmd: string, args: string[], opts?: SandboxRunOptions): Promise<SandboxResult>;

  /**
   * Write `content` to `path` inside the sandbox's filesystem view (for
   * NoopSandbox, that's just the host filesystem).
   */
  writeFile(path: string, content: string): Promise<void>;
}

/**
 * Zero-isolation SandboxAdapter: runs commands directly on the host via
 * node:child_process.execFile, and writes files directly via
 * node:fs/promises.writeFile. This is exactly the "trusted host" behavior
 * the SDK had before any sandboxing existed - it exists so tools that
 * don't need real isolation (or environments without a sandbox backend
 * available, like this one without Docker - see LOU-F6) still have a
 * SandboxAdapter to route through.
 */
export const NoopSandbox: SandboxAdapter = {
  name: 'noop',

  async run(cmd: string, args: string[], opts: SandboxRunOptions = {}): Promise<SandboxResult> {
    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        timeout: opts.timeoutMs,
        signal: opts.signal,
      });
      return { stdout: stdout.toString(), stderr: stderr.toString(), exitCode: 0 };
    } catch (error: any) {
      // execFile rejects on non-zero exit code (error.code is then the
      // numeric exit code); surface that as a result per the interface
      // contract rather than a rejection. A spawn failure (e.g. ENOENT -
      // the binary doesn't exist) has a string errno `.code` instead, and
      // is a genuine failure to run the command, so it's rethrown.
      if (typeof error.code === 'number') {
        return {
          stdout: (error.stdout ?? '').toString(),
          stderr: (error.stderr ?? '').toString(),
          exitCode: error.code,
        };
      }
      throw error;
    }
  },

  async writeFile(path: string, content: string): Promise<void> {
    await fsWriteFile(path, content, 'utf-8');
  },
};
