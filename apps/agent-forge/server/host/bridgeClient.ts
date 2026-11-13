/**
 * BridgeClient: Studio's side of `lousho bridge` (PLAN §19.4). One instance
 * owns one workspace's bridge child process: it spawns the project's own
 * SDK, performs the `hello` handshake, sends NDJSON requests with
 * per-method timeouts, routes pushes to per-run listeners and restarts a
 * crashed child with backoff.
 *
 * Push buffering exists because the bridge writes the `run`/`chat` response
 * line *before* that segment's pushes, and readline can deliver several
 * lines in one chunk: a caller that awaits `request('run')` and only then
 * calls `onPush(runId)` would otherwise lose the first pushes. Buffers are
 * per run id, capped, and swept after five minutes so a run nobody listens
 * to cannot grow memory without bound.
 *
 * `unsupported` never respawns: an SDK too old to know `bridge` will not
 * grow the command later in the same process, so retrying would spin.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeHelloResult,
  type BridgeMethod,
  type BridgeParams,
  type BridgePush,
  type BridgeResults,
} from 'lousho';

/** Lifecycle of the bridge child this client owns. */
export type BridgeState = 'idle' | 'starting' | 'ready' | 'restarting' | 'failed' | 'unsupported' | 'stopped';

/** How to launch the bridge: the `lousho` binary (or `node dist/cli/bin/lousho.js`) inside the workspace. */
export interface BridgeSpawnSpec {
  /** The executable (`lousho`, `node`, ...). */
  command: string;
  /** Its arguments (`['bridge']`, or `[entry, 'bridge']`). */
  args: string[];
  /** The workspace root the bridge resolves specs against. */
  cwd: string;
  /** Environment for the child; the caller merges the workspace env. */
  env: NodeJS.ProcessEnv;
  /** Workspace name, used to prefix stderr lines. */
  label: string;
}

/** Per-method request timeouts in milliseconds. */
export interface BridgeTimeouts {
  hello: number;
  catalog: number;
  compile: number;
  run: number;
  chat: number;
  resolveApproval: number;
  answerQuestion: number;
  steer: number;
  abort: number;
  shutdown: number;
}

/** Default per-method timeouts (PLAN §19.4). */
// fallow-ignore-next-line unused-export -- W11b/W11c contract surface; only tests consume it until the host lands
export const BRIDGE_TIMEOUTS: BridgeTimeouts = {
  hello: 15_000,
  catalog: 15_000,
  compile: 60_000,
  run: 60_000,
  chat: 60_000,
  resolveApproval: 60_000,
  answerQuestion: 60_000,
  steer: 10_000,
  abort: 10_000,
  shutdown: 5_000,
};

/** Respawn delays after consecutive crashes; the last value repeats. */
// fallow-ignore-next-line unused-export -- W11b/W11c contract surface; only tests consume it until the host lands
export const BRIDGE_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

/** Crashes inside {@link BRIDGE_CRASH_WINDOW_MS} that flip the client to `failed`. */
// fallow-ignore-next-line unused-export -- W11b/W11c contract surface; only tests consume it until the host lands
export const BRIDGE_CRASH_LIMIT = 5;

/** The sliding window crash times are counted in. */
// fallow-ignore-next-line unused-export -- W11b/W11c contract surface; only tests consume it until the host lands
export const BRIDGE_CRASH_WINDOW_MS = 5 * 60_000;

/** Staying `ready` this long clears the crash counter. */
// fallow-ignore-next-line unused-export -- W11b/W11c contract surface; only tests consume it until the host lands
export const BRIDGE_HEALTHY_RESET_MS = 60_000;

/** Pushes buffered per run id while no listener is registered. */
// fallow-ignore-next-line unused-export -- W11b/W11c contract surface; only tests consume it until the host lands
export const BRIDGE_PUSH_BUFFER_LIMIT = 10_000;

/** After SIGTERM, how long the child gets before SIGKILL. */
// fallow-ignore-next-line unused-export -- W11b/W11c contract surface; only tests consume it until the host lands
export const BRIDGE_KILL_GRACE_MS = 2_000;

/** Pushes for a run nobody ever listens to are dropped after this long. */
const PUSH_BUFFER_TTL_MS = 5 * 60_000;

/** `recentStderr()` keeps this many trailing lines. */
const STDERR_RING = 200;

/** A failed bridge call. `code` is the bridge's error code or a client code (`LOUSHO_BRIDGE_*`). */
export class BridgeError extends Error {
  /** @param message Human-readable failure. @param code Stable `LOUSHO_*` code. @param details The bridge's `error.details`, when it sent any. */
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

/** Test hooks and sinks; everything defaults to production behaviour. */
export interface BridgeClientOptions {
  /** Child-process factory; tests inject a fake. Defaults to `node:child_process` `spawn`. */
  spawn?: typeof nodeSpawn;
  /** Per-method timeout overrides merged over {@link BRIDGE_TIMEOUTS}. */
  timeouts?: Partial<BridgeTimeouts>;
  /** Respawn delay overrides merged over {@link BRIDGE_BACKOFF_MS}. */
  backoffMs?: readonly number[];
  /** Clock override for crash-window bookkeeping. */
  now?: () => number;
  /** Timer factory; tests may substitute fake timers. The result's `unref` is called when present. */
  setTimer?: (fn: () => void, ms: number) => { unref?(): void };
  /** stderr sink; defaults to `process.stderr.write` prefixed with `[bridge <label>]`. */
  stderr?: (line: string) => void;
  /** Studio's own version, sent as `hello.client.version`. */
  clientVersion: string;
}

interface PendingRequest {
  method: BridgeMethod;
  resolve: (result: unknown) => void;
  reject: (error: BridgeError) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PushBuffer {
  at: number;
  lines: BridgePush[];
  warned: boolean;
}

interface Deferred {
  promise: Promise<BridgeHelloResult>;
  resolve: (hello: BridgeHelloResult) => void;
  reject: (error: BridgeError) => void;
}

const deferred = (): Deferred => {
  let resolve!: Deferred['resolve'];
  let reject!: Deferred['reject'];
  const promise = new Promise<BridgeHelloResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Readiness waiters handle the rejection; this keeps an unwatched gate quiet.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
};

/** One bridge child process: handshake, requests, pushes, crash recovery. */
export class BridgeClient {
  private readonly spec: BridgeSpawnSpec;
  private readonly options: BridgeClientOptions;
  private readonly timeouts: BridgeTimeouts;
  private readonly backoffMs: readonly number[];
  private readonly now: () => number;
  private readonly logStderr: (line: string) => void;

  private current: BridgeState = 'idle';
  private child: ChildProcess | undefined;
  private rl: ReturnType<typeof createInterface> | undefined;
  private errRl: ReturnType<typeof createInterface> | undefined;
  private expectingExit = false;
  private exitWaiters: (() => void)[] = [];

  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Map<string, (push: BridgePush) => void>();
  private readonly buffers = new Map<string, PushBuffer>();
  private readonly warnedRuns = new Set<string>();

  private helloResult: BridgeHelloResult | undefined;
  private gate: Deferred = deferred();
  private crashTimes: number[] = [];
  private healthyTimer: ReturnType<typeof setTimeout> | undefined;
  private respawnTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly stateListeners = new Set<(state: BridgeState) => void>();
  private readonly stderrLines: string[] = [];

  /** @param spec How to spawn the bridge. @param options Timeouts, timers, sinks and the client version. */
  constructor(spec: BridgeSpawnSpec, options: BridgeClientOptions) {
    this.spec = spec;
    this.options = options;
    this.timeouts = { ...BRIDGE_TIMEOUTS, ...options.timeouts };
    this.backoffMs = options.backoffMs ?? BRIDGE_BACKOFF_MS;
    this.now = options.now ?? Date.now;
    this.logStderr =
      options.stderr ?? ((line) => void process.stderr.write(`[bridge ${spec.label}] ${line}\n`));
  }

  /** Current lifecycle state. */
  get state(): BridgeState {
    return this.current;
  }

  /** The `hello` result once the first handshake succeeded. */
  get hello(): BridgeHelloResult | undefined {
    return this.helloResult;
  }

  /** Spawns the child and handshakes; idempotent while `starting`/`ready`. */
  start(): Promise<BridgeHelloResult> {
    return this.ensureReady();
  }

  /** Sends one request; waits for `ready` first when the child is starting or restarting. */
  async request<M extends BridgeMethod>(method: M, params: BridgeParams[M]): Promise<BridgeResults[M]> {
    const hello = await this.ensureReady();
    void hello;
    return this.call(method, params, this.timeouts[method]) as Promise<BridgeResults[M]>;
  }

  /**
   * Registers the listener for a run id and flushes buffered pushes to it
   * in order, synchronously. Returns the unsubscribe function.
   */
  onPush(runId: string, listener: (push: BridgePush) => void): () => void {
    this.listeners.set(runId, listener);
    const buffer = this.buffers.get(runId);
    if (buffer !== undefined) {
      this.buffers.delete(runId);
      this.warnedRuns.delete(runId);
      for (const push of buffer.lines) listener(push);
    }
    return () => {
      if (this.listeners.get(runId) === listener) this.listeners.delete(runId);
    };
  }

  /** Subscribes to lifecycle changes (W11c turns these into `host.status` events). */
  onStateChange(listener: (state: BridgeState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Clears the crash counter and starts again — the "Restart" banner action. */
  async restart(): Promise<BridgeHelloResult> {
    this.crashTimes = [];
    if (this.current !== 'idle') await this.stop();
    return this.start();
  }

  /** `shutdown` request → SIGTERM → grace → SIGKILL. Never rejects. */
  async stop(): Promise<void> {
    if (this.current === 'stopped') return;
    this.expectingExit = true;
    this.clearRespawnTimer();
    const child = this.child;
    if (child === undefined || this.current === 'idle') {
      this.finishStop();
      return;
    }
    try {
      await this.call('shutdown', {} as BridgeParams['shutdown'], this.timeouts.shutdown);
    } catch {
      // A dead or hung bridge still gets the signal path below.
    }
    if (this.child !== undefined) {
      child.kill('SIGTERM');
      await this.waitForExit(BRIDGE_KILL_GRACE_MS);
      if (this.child !== undefined) {
        child.kill('SIGKILL');
        await this.waitForExit(BRIDGE_KILL_GRACE_MS);
      }
    }
    this.finishStop();
  }

  /** The last {@link STDERR_RING} stderr lines the child wrote (W11c's banner detail). */
  recentStderr(): string[] {
    return [...this.stderrLines];
  }

  // -- readiness -----------------------------------------------------------

  private ensureReady(): Promise<BridgeHelloResult> {
    switch (this.current) {
      case 'ready':
        return Promise.resolve(this.helloResult as BridgeHelloResult);
      case 'starting':
      case 'restarting':
        return this.gate.promise;
      case 'failed':
        return Promise.reject(
          new BridgeError("The project's agent process keeps stopping. Restart it from the banner.", 'LOUSHO_BRIDGE_FAILED')
        );
      case 'unsupported':
        return Promise.reject(
          new BridgeError("This project's SDK has no 'lousho bridge' command.", 'LOUSHO_BRIDGE_UNSUPPORTED')
        );
      default:
        this.beginAttempt();
        return this.gate.promise;
    }
  }

  // -- spawn + handshake -----------------------------------------------------

  private beginAttempt(): void {
    this.gate = deferred();
    this.setState('starting');
    const spawnFn = this.options.spawn ?? nodeSpawn;
    let child: ChildProcess;
    try {
      child = spawnFn(this.spec.command, this.spec.args, {
        cwd: this.spec.cwd,
        env: this.spec.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      this.attemptFailed(
        new BridgeError(`Could not spawn the project's agent process: ${error instanceof Error ? error.message : String(error)}`, 'LOUSHO_BRIDGE_SPAWN')
      );
      return;
    }
    this.child = child;
    this.wireChild(child);
    void this.handshake(child);
  }

  private wireChild(child: ChildProcess): void {
    this.rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    this.errRl = createInterface({ input: child.stderr!, crlfDelay: Infinity });
    this.rl.on('line', (line) => this.handleLine(line));
    this.errRl.on('line', (line) => this.recordStderr(line));
    child.on('error', (error) => {
      if (this.child !== child) return;
      this.attemptFailed(
        new BridgeError(`Could not spawn the project's agent process: ${error.message}`, 'LOUSHO_BRIDGE_SPAWN')
      );
    });
    child.on('exit', (code, signal) => this.handleExit(child, code, signal));
  }

  private async handshake(child: ChildProcess): Promise<void> {
    try {
      const hello = (await this.call('hello', this.helloParams(), this.timeouts.hello)) as BridgeHelloResult;
      if (this.child !== child) return; // stopped or replaced mid-handshake
      this.helloResult = hello;
      this.setState('ready');
      this.gate.resolve(hello);
      this.healthyTimer = this.setTimer(() => {
        this.crashTimes = [];
      }, BRIDGE_HEALTHY_RESET_MS);
    } catch (error) {
      if (this.child === child) this.attemptFailed(error);
    }
  }

  private helloParams(): BridgeParams['hello'] {
    return {
      protocol: BRIDGE_PROTOCOL_VERSION,
      client: { name: '@lousho/studio', version: this.options.clientVersion },
    };
  }

  /** A start attempt that failed before `ready`: kill the child, fail or count the crash. */
  private attemptFailed(error: unknown): void {
    const bridgeError =
      error instanceof BridgeError
        ? error
        : new BridgeError(error instanceof Error ? error.message : String(error), 'LOUSHO_BRIDGE_CRASHED');
    this.expectingExit = true;
    const child = this.child;
    this.teardownChild();
    child?.kill('SIGKILL');
    this.gate.reject(bridgeError);
    this.setState('failed');
  }

  // -- requests --------------------------------------------------------------

  private call(method: BridgeMethod, params: unknown, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    const stdin = child?.stdin;
    if (child === undefined || stdin === null || stdin === undefined || !stdin.writable) {
      return Promise.reject(new BridgeError("The project's agent process is not running.", 'LOUSHO_BRIDGE_CRASHED'));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = this.setTimer(() => {
        this.pending.delete(id);
        reject(new BridgeError(`${method} timed out after ${timeoutMs} ms.`, 'LOUSHO_BRIDGE_TIMEOUT'));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new BridgeError(`Could not write to the project's agent process: ${error instanceof Error ? error.message : String(error)}`, 'LOUSHO_BRIDGE_CRASHED'));
      }
    });
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.logStderr(`non-protocol output: ${line}`);
      return;
    }
    if (typeof message !== 'object' || message === null) {
      this.logStderr(`non-protocol output: ${line}`);
      return;
    }
    const record = message as { id?: unknown; event?: unknown; runId?: unknown; error?: { code?: string; message?: string; details?: unknown } };
    if (typeof record.event === 'string' && typeof record.runId === 'string') {
      this.handlePush({ event: record.event, runId: record.runId, data: (message as BridgePush).data } as BridgePush);
      return;
    }
    if (record.id === null && record.error !== undefined) {
      this.logStderr(`bridge error: ${record.error.message ?? line}`);
      return;
    }
    if (typeof record.id === 'number') this.handleResponse(record.id, message as { result?: unknown; error?: { code: string; message: string; details?: unknown } });
  }

  private handleResponse(id: number, message: { result?: unknown; error?: { code: string; message: string; details?: unknown } }): void {
    const entry = this.pending.get(id);
    if (entry === undefined) return; // timed out already; a late response is dropped
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (message.error !== undefined) {
      entry.reject(new BridgeError(message.error.message, message.error.code, message.error.details));
    } else {
      entry.resolve(message.result);
    }
  }

  // -- pushes -----------------------------------------------------------------

  private handlePush(push: BridgePush): void {
    this.sweepBuffers();
    const listener = this.listeners.get(push.runId);
    if (listener !== undefined) {
      listener(push);
      return;
    }
    let buffer = this.buffers.get(push.runId);
    if (buffer === undefined) {
      buffer = { at: this.now(), lines: [], warned: false };
      this.buffers.set(push.runId, buffer);
    }
    buffer.at = this.now();
    if (buffer.lines.length >= BRIDGE_PUSH_BUFFER_LIMIT) {
      buffer.lines.shift();
      if (!buffer.warned && !this.warnedRuns.has(push.runId)) {
        buffer.warned = true;
        this.warnedRuns.add(push.runId);
        this.logStderr(`push buffer for run ${push.runId} is full; dropping the oldest pushes`);
      }
    }
    buffer.lines.push(push);
  }

  private sweepBuffers(): void {
    const cutoff = this.now() - PUSH_BUFFER_TTL_MS;
    for (const [runId, buffer] of this.buffers) {
      if (buffer.at < cutoff) {
        this.buffers.delete(runId);
        this.warnedRuns.delete(runId);
      }
    }
  }

  // -- exit / crash -------------------------------------------------------------

  private handleExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.teardownChild();
    for (const waiter of this.exitWaiters.splice(0)) waiter();
    if (this.expectingExit) {
      this.rejectPending('LOUSHO_BRIDGE_STOPPED', 'The bridge was stopped.');
      return;
    }
    if (this.current === 'starting' && code === 2 && this.sawUnknownCommand()) {
      this.rejectPending('LOUSHO_BRIDGE_UNSUPPORTED', "This project's SDK has no 'lousho bridge' command.");
      this.gate.reject(
        new BridgeError("This project's SDK has no 'lousho bridge' command.", 'LOUSHO_BRIDGE_UNSUPPORTED')
      );
      this.setState('unsupported');
      return;
    }
    this.onCrash(code, signal);
  }

  private sawUnknownCommand(): boolean {
    return this.stderrLines.some((line) => line.includes("unknown command 'bridge'"));
  }

  /** An unexpected exit: fail pending work, notify runs, count the crash, respawn or fail. */
  private onCrash(code: number | null, signal: NodeJS.Signals | null): void {
    const where = code !== null ? `exit code ${code}` : `signal ${signal ?? 'unknown'}`;
    this.rejectPending('LOUSHO_BRIDGE_CRASHED', `The project's agent process stopped unexpectedly (${where}).`);
    for (const runId of [...this.listeners.keys()]) {
      this.listeners.get(runId)?.({
        event: 'run.failed',
        runId,
        data: {
          code: 'LOUSHO_BRIDGE_CRASHED',
          message: `The project's agent process stopped unexpectedly (${where}). The run was interrupted.`,
        },
      } as BridgePush);
    }
    this.listeners.clear();
    this.buffers.clear();
    this.warnedRuns.clear();

    const windowStart = this.now() - BRIDGE_CRASH_WINDOW_MS;
    this.crashTimes = [...this.crashTimes.filter((at) => at > windowStart), this.now()];
    if (this.crashTimes.length >= BRIDGE_CRASH_LIMIT) {
      this.gate.reject(
        new BridgeError("The project's agent process keeps stopping. Restart it from the banner.", 'LOUSHO_BRIDGE_FAILED')
      );
      this.setState('failed');
      return;
    }
    // Settle the old epoch's waiters, then open a fresh one for the respawn.
    this.gate.reject(
      new BridgeError(`The project's agent process stopped unexpectedly (${where}).`, 'LOUSHO_BRIDGE_CRASHED')
    );
    this.gate = deferred();
    this.setState('restarting');
    const step = this.backoffMs[Math.min(this.crashTimes.length - 1, this.backoffMs.length - 1)];
    this.respawnTimer = this.setTimer(() => {
      this.respawnTimer = undefined;
      if (this.current === 'restarting' && !this.expectingExit) this.beginAttempt();
    }, step);
  }

  private rejectPending(code: string, message: string): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new BridgeError(message, code));
    }
    this.pending.clear();
  }

  // -- shutdown ------------------------------------------------------------------

  private waitForExit(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = this.setTimer(resolve, ms);
      this.exitWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private finishStop(): void {
    this.teardownChild();
    this.rejectPending('LOUSHO_BRIDGE_STOPPED', 'The bridge was stopped.');
    this.gate.reject(new BridgeError('The bridge was stopped.', 'LOUSHO_BRIDGE_STOPPED'));
    this.setState('stopped');
  }

  private teardownChild(): void {
    this.rl?.close();
    this.errRl?.close();
    this.rl = undefined;
    this.errRl = undefined;
    this.child = undefined;
    this.expectingExit = false;
    if (this.healthyTimer !== undefined) {
      clearTimeout(this.healthyTimer);
      this.healthyTimer = undefined;
    }
  }

  private clearRespawnTimer(): void {
    if (this.respawnTimer !== undefined) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = undefined;
    }
  }

  private setState(state: BridgeState): void {
    if (this.current === state) return;
    this.current = state;
    for (const listener of this.stateListeners) listener(state);
  }

  private recordStderr(line: string): void {
    this.stderrLines.push(line);
    if (this.stderrLines.length > STDERR_RING) this.stderrLines.shift();
    this.logStderr(line);
  }

  private setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const timer = (this.options.setTimer ?? ((f: () => void, m: number) => setTimeout(f, m)))(fn, ms) as unknown as ReturnType<typeof setTimeout>;
    (timer as { unref?: () => void }).unref?.();
    return timer;
  }
}
