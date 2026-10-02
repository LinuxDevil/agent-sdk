/**
 * SandboxShell: a ShellProvider backed by a SandboxAdapter (LOU-X6).
 */
import type { SandboxAdapter } from '../../security/sandboxCore';
import { commandEnv } from '../../security/commandEnv';
import type { ShellExecOptions, ShellExecResult, ShellProvider } from './types';
import { normalizeWorkspacePath } from './paths';

/** Options for {@link SandboxShell}. */
export interface SandboxShellOptions {
  /**
   * Working directory passed to the sandbox for every command. For
   * `SubprocessSandbox` this is an absolute HOST directory that is
   * bind-mounted (at the same path) into the container - the only host
   * directory the command can see. A per-call `cwd` is joined onto it.
   */
  cwd?: string;
  /** Shell binary inside the sandbox. Defaults to `'sh'`. */
  shell?: string;
  /** Values set for every command (a per-call `env` wins). Visible to the model's commands. */
  env?: Record<string, string>;
  /**
   * Names of host environment variables to copy into every command, e.g.
   * `['CI']`. Nothing else from the host is passed. A container brings its own
   * `PATH` and `HOME`; a host-process adapter (`NoopSandbox`) adds the same
   * small base `NodeWorkspace` uses. `true` lets a host-process adapter pass
   * the whole host environment (the behavior before LOU-X11); a container
   * still never gets it.
   */
  inheritEnv?: readonly string[] | true;
}

function isTimeoutError(error: unknown): boolean {
  return /timed out/i.test((error as Error | undefined)?.message ?? '');
}

function joinCwd(base: string | undefined, sub: string | undefined): string | undefined {
  const rel = sub === undefined ? '.' : normalizeWorkspacePath(sub, 'posix');
  if (rel === '.') return base;
  return base ? `${base.replace(/[\\/]+$/, '')}/${rel}` : rel;
}

/**
 * Runs the `shell` tool's commands through a {@link SandboxAdapter}, e.g.
 * the Docker-backed `SubprocessSandbox`: each command runs as
 * `sh -c "<command>"` in a fresh, network-less container that sees only
 * `cwd`. Commands get only the variables in `env` and the host variables
 * named in `inheritEnv` - never the rest of the host environment.
 *
 * Cancellation: the abort signal goes to the adapter, so `SubprocessSandbox`
 * kills and removes the container, and the result says `aborted: true`. An
 * adapter that ignores the signal still stops being waited on at once, but
 * its command runs on until the timeout the shell tool always passes.
 *
 * @example
 * ```ts
 * import { createShellTool, SandboxShell, SubprocessSandbox } from '@lousho/build-ai-agent';
 * const shell = new SandboxShell(new SubprocessSandbox({ image: 'node:20-alpine' }), { cwd: '/abs/path/to/project' });
 * const tool = createShellTool(shell, { needsApproval: false });
 * ```
 */
export class SandboxShell implements ShellProvider {
  private readonly env: Record<string, string>;

  constructor(
    private readonly sandbox: SandboxAdapter,
    private readonly options: SandboxShellOptions = {}
  ) {
    const names = options.inheritEnv === true ? [] : options.inheritEnv;
    this.env = commandEnv({ env: options.env, inheritEnv: names }, { base: false });
  }

  async exec(command: string, options: ShellExecOptions = {}): Promise<ShellExecResult> {
    const aborted: ShellExecResult = { stdout: '', stderr: '', exitCode: null, timedOut: false, aborted: true };
    if (options.signal?.aborted) return aborted;
    const run = this.sandbox
      .run(this.options.shell ?? 'sh', ['-c', command], {
        cwd: joinCwd(this.options.cwd, options.cwd),
        env: { ...this.env, ...options.env },
        inheritEnv: this.options.inheritEnv === true,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      })
      .then(
        (result): ShellExecResult => ({ ...result, timedOut: false }),
        (error: unknown): ShellExecResult => {
          if (options.signal?.aborted && (error as Error | undefined)?.name === 'AbortError') return aborted;
          if (options.timeoutMs !== undefined && isTimeoutError(error)) {
            return { stdout: '', stderr: '', exitCode: null, timedOut: true };
          }
          throw error;
        }
      );
    if (!options.signal) return run;
    const signal = options.signal;
    let onAbort = () => {};
    const abort = new Promise<ShellExecResult>((resolve) => {
      onAbort = () => resolve(aborted);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return Promise.race([run, abort]).finally(() => signal.removeEventListener('abort', onAbort));
  }
}
