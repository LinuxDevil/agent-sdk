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
import type Docker from 'dockerode';
import { lazyValue, loadOptionalPeer } from '../providers/optionalPeer';
import { SandboxAdapter, SandboxResult, SandboxRunOptions } from './sandboxCore';
import { isHostPattern } from './hostPattern';

export * from './sandboxCore';

/** The fields of a dockerode rejection this module inspects. */
type DockerodeError = { statusCode?: number; json?: { message?: string }; message?: string };

/** dockerode carries the daemon's message under `json.message`; fall back to `message`. */
function dockerErrorMessage(e: DockerodeError): string {
  return e.json?.message ?? e.message ?? '';
}

/** True if `err` is dockerode's 404 "no such image" rejection for `image`. */
function isNoSuchImageError(err: unknown, image: string): boolean {
  const e = (err ?? {}) as DockerodeError;
  const message = dockerErrorMessage(e);
  return e.statusCode === 404 && message.toLowerCase().includes('no such image') && message.includes(image);
}

/**
 * Network access for a {@link SubprocessSandbox} container (LOU-X11):
 * - `'none'` (default): no network at all (Docker `NetworkMode: 'none'`).
 * - `'default'`: Docker's default network, unrestricted egress.
 * - `{ allow: ['api.github.com', '*.npmjs.org'] }`: only these hosts. Docker
 *   cannot filter egress by host name on its own, so this needs an egress
 *   proxy that is the container's only route out. `createCredentialBroker()`
 *   (LOU-X12) is such a proxy, but containers are not routed through it yet
 *   (LOU-X12.2), so the container gets no network (fail closed); the
 *   validated list is kept on {@link SubprocessSandbox.network}.
 */
export type SandboxNetwork = 'none' | 'default' | { allow: readonly string[] };

/** Validates a network policy, lower-casing allowlisted host names. Throws a readable error on a bad one. */
function validateNetwork(network: SandboxNetwork = 'none'): SandboxNetwork {
  if (network === 'none' || network === 'default') return network;
  if (!Array.isArray(network?.allow)) {
    throw new Error(`SubprocessSandbox: network must be 'none', 'default' or { allow: string[] }; got ${JSON.stringify(network)}.`);
  }
  const invalid = network.allow.filter((host) => !isHostPattern(host));
  if (invalid.length > 0) {
    throw new Error(`SubprocessSandbox: network.allow takes host names such as 'api.github.com' or '*.npmjs.org'; got ${JSON.stringify(invalid)}.`);
  }
  return { allow: Object.freeze(network.allow.map((host) => host.toLowerCase())) };
}

/**
 * Container config for one `run()` call: auto-removed, bind-mounting only
 * `opts.cwd` (when given), with only `opts.env` (never the host env) and no
 * network unless the policy is `'default'`.
 */
function buildContainerOptions(
  image: string,
  network: SandboxNetwork,
  cmd: string,
  args: string[],
  opts: SandboxRunOptions
): Docker.ContainerCreateOptions {
  const binds = opts.cwd ? [`${opts.cwd}:${opts.cwd}`] : undefined;
  return {
    Image: image,
    Cmd: [cmd, ...args],
    WorkingDir: opts.cwd,
    Env: opts.env ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`) : undefined,
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    HostConfig: {
      NetworkMode: network === 'default' ? 'default' : 'none',
      AutoRemove: true,
      Binds: binds,
    },
  };
}

/** A pair of PassThrough sinks that buffer everything written to them. */
function captureOutput() {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
  return {
    stdout,
    stderr,
    read: () => ({
      stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
      stderr: Buffer.concat(stderrChunks).toString('utf-8'),
    }),
  };
}

/** Runs `fn` and ignores its failure: the container may already be stopped or gone (AutoRemove). */
async function ignoreFailure(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    /* already stopped or removed */
  }
}

/** Kills the container and force-removes it (LOU-U23); safe when it already exited or AutoRemove took it. */
async function stopContainer(container: Docker.Container): Promise<void> {
  await ignoreFailure(() => container.kill());
  await ignoreFailure(() => container.remove({ force: true }));
}

/**
 * `container.wait()`, or whichever comes first of the container exiting, the
 * timeout and the abort `signal`. A timeout or abort stops and removes the
 * container (once) and rejects: with a "timed out" error, or an `AbortError`
 * like `NoopSandbox` (LOU-U23). Listeners and the timer are always cleaned up.
 */
async function waitForExit(
  container: Docker.Container,
  { timeoutMs, signal }: Pick<SandboxRunOptions, 'timeoutMs' | 'signal'>
): Promise<unknown> {
  let cleanup = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    let stopped = false;
    const interrupt = (error: Error) => {
      if (stopped) return;
      stopped = true;
      reject(error);
      void stopContainer(container);
    };
    const onAbort = () => interrupt(new DOMException('The command was aborted', 'AbortError'));
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => interrupt(new Error(`SubprocessSandbox: command timed out after ${timeoutMs}ms`)), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
  });
  try {
    return await Promise.race([container.wait(), interrupted]);
  } finally {
    cleanup();
  }
}

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
  /** Network access for each container. Defaults to `'none'`. See {@link SandboxNetwork} for what `{ allow }` enforces today. */
  network?: SandboxNetwork;
}

/**
 * Docker-backed SandboxAdapter (LOU-F6). Runs each `run()` call in a
 * brand-new, network-isolated (`NetworkMode: 'none'` unless `network` says
 * otherwise), auto-removed
 * (`AutoRemove: true`) container - no bind mounts beyond the explicit
 * `opts.cwd` directory a caller passes in, so the container has no access
 * to the rest of the host filesystem by default.
 *
 * See the top-of-file comment for the Docker daemon prerequisite.
 */
export class SubprocessSandbox implements SandboxAdapter {
  readonly name = 'docker';
  /** dockerode is loaded on first `run()`, not at import or construction time (LOU-D19). */
  private readonly getDocker: () => Promise<Docker>;
  private readonly image: string;
  /** The validated network policy. An `{ allow }` list is kept here; until containers are routed through the credential broker (LOU-X12.2) it means no network. */
  readonly network: SandboxNetwork;

  constructor(options: SubprocessSandboxOptions = {}) {
    this.network = validateNetwork(options.network);
    this.getDocker = lazyValue(async () => {
      const { default: DockerClient } = await loadOptionalPeer('dockerode', () => import('dockerode'));
      return new DockerClient(options.dockerOptions);
    });
    this.image = options.image ?? 'node:20-alpine';
  }

  /**
   * `docker.createContainer()`, transparently pulling `this.image` and
   * retrying once if the daemon doesn't have it locally yet (a fresh
   * daemon, or a CI runner that hasn't pre-pulled it, rejects
   * `createContainer` with a 404 "no such image" error rather than pulling
   * on demand the way `docker run` does). A daemon that's simply
   * unreachable (no daemon at all) still rejects normally here - callers
   * are expected to have already checked `docker.ping()` before
   * constructing a SubprocessSandbox in the first place (see the
   * top-of-file Docker-prerequisite note).
   */
  private async createContainer(
    docker: Docker,
    options: Docker.ContainerCreateOptions
  ): Promise<Docker.Container> {
    try {
      return await docker.createContainer(options);
    } catch (err) {
      if (!isNoSuchImageError(err, this.image)) {
        throw err;
      }
      await new Promise<void>((resolve, reject) => {
        docker.pull(this.image, (pullErr: Error | null, stream?: NodeJS.ReadableStream) => {
          if (pullErr || !stream) {
            reject(pullErr ?? new Error(`SubprocessSandbox: failed to start pulling image '${this.image}'`));
            return;
          }
          docker.modem.followProgress(stream, (followErr: Error | null) =>
            followErr ? reject(followErr) : resolve()
          );
        });
      });
      return docker.createContainer(options);
    }
  }

  /**
   * Runs `cmd`/`args` inside a fresh, network-isolated container and
   * resolves with its captured stdout/stderr/exitCode. When `opts.signal`
   * aborts, the container is killed and removed and `run()` rejects with an
   * `AbortError` (an already-aborted signal starts no container).
   */
  async run(cmd: string, args: string[], opts: SandboxRunOptions = {}): Promise<SandboxResult> {
    opts.signal?.throwIfAborted();
    const docker = await this.getDocker();
    const container = await this.createContainer(docker, buildContainerOptions(this.image, this.network, cmd, args, opts));

    const output = captureOutput();
    const attachStream = await container.attach({ stream: true, stdout: true, stderr: true });
    docker.modem.demuxStream(attachStream, output.stdout, output.stderr);

    await container.start();
    const result = await waitForExit(container, opts);

    return {
      ...output.read(),
      exitCode: (result as { StatusCode: number }).StatusCode,
    };
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
