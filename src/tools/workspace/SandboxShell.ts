/**
 * SandboxShell: a ShellProvider backed by a SandboxAdapter (LOU-X6).
 */
import type { SandboxAdapter } from '../../security/sandboxCore';
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
 * `cwd`. Commands get only the variables in `options.env` - nothing from the
 * host environment.
 *
 * Limitation: `SandboxAdapter` has no cancellation hook, so an aborted run
 * stops waiting at once (the result says `aborted: true`) but the container
 * keeps running until its timeout kills it. The shell tool always passes a
 * timeout, so it is bounded.
 *
 * @example
 * ```ts
 * import { createShellTool, SandboxShell, SubprocessSandbox } from '@loushy/build-ai-agent';
 * const shell = new SandboxShell(new SubprocessSandbox({ image: 'node:20-alpine' }), { cwd: '/abs/path/to/project' });
 * const tool = createShellTool(shell, { needsApproval: false });
 * ```
 */
export class SandboxShell implements ShellProvider {
  constructor(
    private readonly sandbox: SandboxAdapter,
    private readonly options: SandboxShellOptions = {}
  ) {}

  async exec(command: string, options: ShellExecOptions = {}): Promise<ShellExecResult> {
    const aborted: ShellExecResult = { stdout: '', stderr: '', exitCode: null, timedOut: false, aborted: true };
    if (options.signal?.aborted) return aborted;
    const run = this.sandbox
      .run(this.options.shell ?? 'sh', ['-c', command], {
        cwd: joinCwd(this.options.cwd, options.cwd),
        env: options.env,
        timeoutMs: options.timeoutMs,
      })
      .then(
        (result): ShellExecResult => ({ ...result, timedOut: false }),
        (error: unknown): ShellExecResult => {
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
