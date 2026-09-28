/**
 * Sandbox adapter interface (LOU-F4), its trusted-host, zero-isolation
 * implementation NoopSandbox, and its Docker-backed real-isolation
 * implementation SubprocessSandbox (LOU-F6).
 *
 * A SandboxAdapter is the seam through which a tool that opts in via
 * `ToolDescriptor.requiresSandbox` gets its command execution routed
 * (see AgentExecutor's `executeToolCall`, LOU-F5) instead of running
 * in-process. NoopSandbox is the default: it runs commands directly on
 * the host via node:child_process, i.e. exactly the trusted-host behavior
 * this SDK already had before sandboxing existed. A real isolation
 * backend (Docker-backed SubprocessSandbox) implements the same interface.
 *
 * ---------------------------------------------------------------------
 * SubprocessSandbox Docker prerequisite
 * ---------------------------------------------------------------------
 * SubprocessSandbox talks to a running Docker daemon via dockerode (the
 * same daemon `docker` CLI commands talk to - on Windows/macOS that's
 * Docker Desktop; on Linux, the `dockerd` service). It does NOT bundle or
 * start Docker itself: if no daemon is reachable (e.g. Docker Desktop
 * isn't running), every `run()`/`writeFile()` call that requires
 * container operations will reject with a connection error from
 * dockerode. Callers that want to use SubprocessSandbox are responsible
 * for ensuring a daemon is up first (e.g. `docker version` succeeds).
 */


import { writeFile as fsWriteFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import Docker from 'dockerode';
import { SandboxAdapter, SandboxResult, SandboxRunOptions } from './sandboxCore';

export * from './sandboxCore';

/**
 * Configuration for SubprocessSandbox.
 */
export interface SubprocessSandboxOptions {
  /** Docker image to run commands in. Defaults to 'node:20-alpine'. */
  image?: string;
  /**
   * Options forwarded to dockerode's `Docker` constructor (socket path,
   * host/port, TLS, etc). Defaults to dockerode's own defaults, which
   * auto-detect the platform-appropriate Docker daemon connection
   * (npipe on Windows, unix socket on Linux/macOS).
   */
  dockerOptions?: Docker.DockerOptions;
}

/**
 * Docker-backed SandboxAdapter (LOU-F6). Runs each `run()` call in a
 * brand-new, network-isolated (`NetworkMode: 'none'`), auto-removed
 * (`AutoRemove: true`) container - no bind mounts beyond the explicit
 * `opts.cwd` directory a caller passes in, so the container has no access
 * to the rest of the host filesystem by default.
 *
 * See the top-of-file comment for the Docker daemon prerequisite.
 */
export class SubprocessSandbox implements SandboxAdapter {
  readonly name = 'docker';
  private readonly docker: Docker;
  private readonly image: string;

  constructor(options: SubprocessSandboxOptions = {}) {
    this.docker = new Docker(options.dockerOptions);
    this.image = options.image ?? 'node:20-alpine';
  }

  /**
   * Runs `cmd`/`args` inside a fresh, network-isolated container and
   * resolves with its captured stdout/stderr/exitCode.
   */
  async run(cmd: string, args: string[], opts: SandboxRunOptions = {}): Promise<SandboxResult> {
    const binds = opts.cwd ? [`${opts.cwd}:${opts.cwd}`] : undefined;

    const container = await this.docker.createContainer({
      Image: this.image,
      Cmd: [cmd, ...args],
      WorkingDir: opts.cwd,
      Env: opts.env ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`) : undefined,
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      HostConfig: {
        NetworkMode: 'none',
        AutoRemove: true,
        Binds: binds,
      },
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();
    stdoutStream.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    stderrStream.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    const attachStream = await container.attach({ stream: true, stdout: true, stderr: true });
    this.docker.modem.demuxStream(attachStream, stdoutStream, stderrStream);

    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      await container.start();

      const waitPromise = container.wait();
      const result =
        opts.timeoutMs !== undefined
          ? await Promise.race([
              waitPromise,
              new Promise<never>((_, reject) => {
                timeoutHandle = setTimeout(() => {
                  container.kill().catch(() => {});
                  reject(new Error(`SubprocessSandbox: command timed out after ${opts.timeoutMs}ms`));
                }, opts.timeoutMs);
              }),
            ])
          : await waitPromise;

      return {
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        exitCode: (result as { StatusCode: number }).StatusCode,
      };
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /**
   * Writes `content` to `path` on the host. SubprocessSandbox has no
   * persistent container of its own to write into (each `run()` call gets
   * a brand-new, auto-removed container) - a file written here becomes
   * visible inside a subsequent `run()` call only if that call's `opts.cwd`
   * bind-mounts the directory `path` lives in, mirroring how a real
   * "write files into the working directory, then run a command against
   * it" workflow would work.
   */
  async writeFile(path: string, content: string): Promise<void> {
    await fsWriteFile(path, content, 'utf-8');
  }
}
