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


import { randomBytes, type KeyObject } from 'node:crypto';
import { realpath, writeFile as fsWriteFile } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { PassThrough } from 'node:stream';
import type Docker from 'dockerode';
import { lazyValue, loadOptionalPeer } from '../providers/optionalPeer';
import { SandboxAdapter, SandboxResult, SandboxRunOptions } from './sandboxCore';
import { isHostPattern } from './hostPattern';
import { commandEnv } from './commandEnv';
import type { CredentialBroker } from './credentialBroker';
import { Egress, ignoreFailure, startEgress } from './sandboxEgress';
import { SDKError } from '../execution/errors';

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
 *   proxy that is the container's only route out. With a `broker`
 *   (`createCredentialBroker()`), the container joins an internal Docker
 *   network whose only reachable peer is the broker (LOU-X12.2; Docker Engine
 *   on Linux only, see `sandboxEgress.ts`). Without one it gets no network
 *   (fail closed). The validated list is kept on {@link SubprocessSandbox.network}.
 */
export type SandboxNetwork = 'none' | 'default' | { allow: readonly string[] };

/** Validates a network policy, lower-casing allowlisted host names. Throws a readable error on a bad one. */
function validateNetwork(network: SandboxNetwork = 'none'): SandboxNetwork {
  if (network === 'none' || network === 'default') return network;
  if (!Array.isArray(network?.allow)) {
    throw new SDKError(`SubprocessSandbox: network must be 'none', 'default' or { allow: string[] }; got ${JSON.stringify(network)}.`, 'LOUSHO_CONFIG_INVALID');
  }
  const invalid = network.allow.filter((host) => !isHostPattern(host));
  if (invalid.length > 0) {
    throw new SDKError(`SubprocessSandbox: network.allow takes host names such as 'api.github.com' or '*.npmjs.org'; got ${JSON.stringify(invalid)}.`, 'LOUSHO_CONFIG_INVALID');
  }
  return { allow: Object.freeze(network.allow.map((host) => host.toLowerCase())) };
}

/** `NetworkMode`: the egress network when there is one, else `'default'` or `'none'`. */
function networkMode(network: SandboxNetwork, egress: Egress | undefined): string {
  if (egress) return egress.network;
  return network === 'default' ? 'default' : 'none';
}

/** Per-container resource limits of a {@link SubprocessSandbox} (Eve TOOLS-F17). */
export interface SandboxLimits {
  /** Memory cap in bytes (Docker `Memory`). Default 512 MiB. */
  memoryBytes?: number;
  /** Most processes the container may run (Docker `PidsLimit`). Default 256. */
  pids?: number;
  /** CPUs the container may use (Docker `NanoCpus` / 1e9). Default 1. */
  cpus?: number;
}

/** The hardening every container gets: its user and resource limits. */
interface Hardening {
  user: string;
  limits: Required<SandboxLimits>;
}

const DEFAULT_LIMITS: Required<SandboxLimits> = { memoryBytes: 512 * 1024 * 1024, pids: 256, cpus: 1 };

/**
 * Container config for one `run()` call: auto-removed, bind-mounting only
 * `opts.cwd` (when given), with only `opts.env` (never the host env) and no
 * network unless the policy is `'default'` or there is an `egress` network,
 * whose proxy variables are then added to the env. It runs as `hardening.user`
 * with every capability dropped, `no-new-privileges` and the memory, process
 * and CPU limits (Eve TOOLS-F17).
 */
function buildContainerOptions(
  image: string,
  network: SandboxNetwork,
  egress: Egress | undefined,
  hardening: Hardening,
  cmd: string,
  args: string[],
  opts: SandboxRunOptions
): Docker.ContainerCreateOptions {
  const binds = opts.cwd ? [`${opts.cwd}:${opts.cwd}`] : undefined;
  const env = egress ? commandEnv({ env: { ...opts.env, ...egress.env } }, { base: false }) : opts.env;
  return {
    Image: image,
    Cmd: [cmd, ...args],
    User: hardening.user,
    WorkingDir: opts.cwd,
    Env: env ? Object.entries(env).map(([k, v]) => `${k}=${v}`) : undefined,
    NetworkingConfig: egress ? { EndpointsConfig: { [egress.network]: {} } } : undefined,
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    HostConfig: {
      NetworkMode: networkMode(network, egress),
      AutoRemove: true,
      Binds: binds,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      PidsLimit: hardening.limits.pids,
      Memory: hardening.limits.memoryBytes,
      NanoCpus: Math.round(hardening.limits.cpus * 1e9),
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

/** Kills the container and force-removes it (LOU-U23); safe when it already exited or AutoRemove took it. */
async function stopContainer(container: Docker.Container): Promise<void> {
  await ignoreFailure(() => container.kill());
  await ignoreFailure(() => container.remove({ force: true }));
}

/**
 * The `exited` wait (started before `start()`), or whichever comes first of the container exiting, the
 * timeout and the abort `signal`. A timeout or abort stops and removes the
 * container (once) and rejects: with a "timed out" error, or an `AbortError`
 * like `NoopSandbox` (LOU-U23). Listeners and the timer are always cleaned up.
 */
async function waitForExit(
  container: Docker.Container,
  exited: Promise<unknown>,
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
    return await Promise.race([exited, interrupted]);
  } finally {
    cleanup();
  }
}

/**
 * Options forwarded to the dockerode `Docker` constructor (the `dockerOptions`
 * of {@link SubprocessSandboxOptions}): socket path or host/port, TLS material,
 * ssh connection options, etc. Declared structurally - not dockerode's own
 * `Docker.DockerOptions` - so the published declarations do not import the
 * optional `dockerode` peer: a consumer without it installed would otherwise
 * get TS2307 inside the SDK's own `.d.ts` under `skipLibCheck: false`.
 * A dockerode `DockerOptions` value satisfies this shape.
 */
export interface DockerConnectionOptions {
  /** Path of the Docker daemon socket (e.g. `/var/run/docker.sock`, `//./pipe/docker_engine`). */
  socketPath?: string;
  /** Docker daemon host (for `protocol` `'http'`/`'https'`/`'ssh'`). */
  host?: string;
  /** Docker daemon port. */
  port?: number | string;
  username?: string;
  /** Extra headers sent to the daemon. */
  headers?: Record<string, string>;
  /** PEM CA material for a TLS daemon connection. */
  ca?: string | string[] | Buffer | Buffer[];
  /** PEM client certificate for a TLS daemon connection. */
  cert?: string | string[] | Buffer | Buffer[];
  /** PEM client key for a TLS daemon connection. */
  key?: string | string[] | Buffer | Buffer[] | KeyObject[];
  /** Daemon connection protocol. */
  protocol?: 'https' | 'http' | 'ssh';
  /** Request timeout (ms). */
  timeout?: number;
  /** API version to request (e.g. `'v1.44'`). */
  version?: string;
  /** ssh-agent auth for `protocol: 'ssh'` connections. */
  sshAuthAgent?: string;
  /** ssh2 `ConnectConfig` for `protocol: 'ssh'` connections; passed through to dockerode as-is. */
  sshOptions?: object;
  /** Promise implementation for dockerode to use. */
  Promise?: typeof Promise;
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
  dockerOptions?: DockerConnectionOptions;
  /** Network access for each container. Defaults to `'none'`. See {@link SandboxNetwork} for what `{ allow }` enforces. */
  network?: SandboxNetwork;
  /**
   * Egress proxy for `network: { allow }` (LOU-X12.2). The container's only
   * route is to this broker on an internal Docker network; its allowlist there
   * is the broker's rule hosts plus `allow`. Call {@link SubprocessSandbox.close} when done.
   */
  broker?: CredentialBroker;
  /** Internal network to create, or reuse when it exists. Defaults to a fresh `lousho-egress-<random>` name. */
  networkName?: string;
  /**
   * The host directory `writeFile()` may write under (Eve TOOLS-F17).
   * Relative paths resolve against it; a path outside it, also through a
   * symlink, is refused with `LOUSHO_SANDBOX_PATH_DENIED`. Defaults to
   * `process.cwd()` when the sandbox is constructed.
   */
  root?: string;
  /**
   * The user commands run as (Docker `User`). Defaults to `'1000:1000'`, a
   * non-root user; on a Linux host it must be able to write the bind-mounted
   * `cwd`. Pass `'root'` to run as root.
   */
  user?: string;
  /** Per-container limits. Defaults: 512 MiB of memory, 256 processes, 1 CPU. */
  limits?: SandboxLimits;
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
  /** The validated network policy. Without a `broker`, an `{ allow }` list means no network. */
  readonly network: SandboxNetwork;
  private readonly broker?: CredentialBroker;
  private readonly networkName: string;
  /** The internal network and broker listener, set up on the first `run()` (LOU-X12.2). */
  private egress?: Promise<Egress>;
  /** The directory `writeFile()` is confined to. */
  readonly root: string;
  private readonly hardening: Hardening;

  constructor(options: SubprocessSandboxOptions = {}) {
    this.network = validateNetwork(options.network);
    this.broker = options.broker;
    this.networkName = options.networkName ?? `lousho-egress-${randomBytes(4).toString('hex')}`;
    this.getDocker = lazyValue(async () => {
      const { default: DockerClient } = await loadOptionalPeer('dockerode', () => import('dockerode'));
      return new DockerClient(options.dockerOptions as Docker.DockerOptions | undefined);
    });
    this.image = options.image ?? 'node:20-alpine';
    this.root = nodePath.resolve(options.root ?? process.cwd());
    this.hardening = { user: options.user ?? '1000:1000', limits: validateLimits(options.limits) };
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
    const egress = await this.startEgress(docker);
    opts.signal?.throwIfAborted();
    const container = await this.createContainer(docker, buildContainerOptions(this.image, this.network, egress, this.hardening, cmd, args, opts));

    const output = captureOutput();
    const attachStream = await container.attach({ stream: true, stdout: true, stderr: true });
    docker.modem.demuxStream(attachStream, output.stdout, output.stderr);

    // Begin waiting before start(): with AutoRemove a fast command can exit and
    // be removed before a later wait() call, which then fails with a 404 "no
    // such container". 'next-exit' makes the daemon hold the wait until it exits.
    const exited = container.wait({ condition: 'next-exit' });
    exited.catch(() => {});
    try {
      await container.start();
    } catch (error) {
      await stopContainer(container);
      throw error;
    }
    const result = await waitForExit(container, exited, opts);

    return {
      ...output.read(),
      exitCode: (result as { StatusCode: number }).StatusCode,
    };
  }

  /** The egress network for `{ allow }` with a broker, set up once and shared by every run; `undefined` otherwise. */
  private async startEgress(docker: Docker): Promise<Egress | undefined> {
    if (!this.broker || typeof this.network === 'string') return undefined;
    this.egress ??= startEgress(docker, this.broker, this.network.allow, this.networkName).catch((error: unknown) => {
      this.egress = undefined;
      throw error;
    });
    return this.egress;
  }

  /**
   * Stops the broker listener and removes the internal network if this
   * sandbox created it (LOU-X12.2). Call it once no `run()` is in flight; a
   * later `run()` sets them up again. The broker itself keeps running.
   */
  async close(): Promise<void> {
    const egress = this.egress;
    this.egress = undefined;
    const started = await egress?.catch(() => undefined);
    await started?.close();
  }

  /**
   * Writes `content` to `path` on the host, inside {@link SubprocessSandbox.root}.
   * SubprocessSandbox has no persistent container of its own to write into
   * (each `run()` call gets a brand-new, auto-removed container) - a file
   * written here becomes visible inside a subsequent `run()` call only if
   * that call's `opts.cwd` bind-mounts the directory `path` lives in.
   * A path outside the root (`..`, an absolute path elsewhere, or a symlink
   * leading out) rejects with `LOUSHO_SANDBOX_PATH_DENIED` (Eve TOOLS-F17).
   */
  async writeFile(path: string, content: string): Promise<void> {
    await fsWriteFile(await this.confine(path), content, 'utf-8');
  }

  /** `path` resolved against the root, with symlinks followed, or a LOUSHO_SANDBOX_PATH_DENIED rejection when it leaves the root. */
  private async confine(path: string): Promise<string> {
    const root = await realpath(this.root).catch(() => this.root);
    const target = await realTarget(nodePath.resolve(this.root, path));
    const relative = nodePath.relative(root, target);
    if (relative === '' || relative === '..' || relative.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(relative)) {
      throw new SDKError(
        `SubprocessSandbox.writeFile: '${path}' is outside the sandbox root '${this.root}'; write under the root, or pass a different \`root\`.`,
        'LOUSHO_SANDBOX_PATH_DENIED'
      );
    }
    return target;
  }
}

/** `abs` with its longest existing prefix replaced by that prefix's real path, so a symlinked directory cannot lead out. */
async function realTarget(abs: string): Promise<string> {
  const missing: string[] = [];
  let existing = abs;
  for (;;) {
    try {
      return nodePath.join(await realpath(existing), ...missing.reverse());
    } catch {
      const parent = nodePath.dirname(existing);
      if (parent === existing) return abs;
      missing.push(nodePath.basename(existing));
      existing = parent;
    }
  }
}

/** Validates the resource limits, filling in the defaults. */
function validateLimits(limits: SandboxLimits = {}): Required<SandboxLimits> {
  const set = Object.fromEntries(Object.entries(limits).filter(([, value]) => value !== undefined));
  const merged = { ...DEFAULT_LIMITS, ...set } as Required<SandboxLimits>;
  for (const [key, value] of Object.entries(merged)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new SDKError(`SubprocessSandbox: limits.${key} must be a positive number; got ${JSON.stringify(value)}.`, 'LOUSHO_CONFIG_INVALID');
    }
  }
  return merged;
}
