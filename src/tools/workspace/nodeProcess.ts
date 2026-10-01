/**
 * Child-process plumbing for NodeWorkspace.exec (LOU-X6): spawn a shell
 * command, cap what it prints, and kill its whole process tree on timeout
 * or abort - on Windows too.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { ShellExecResult } from './types';
import { WorkspaceError } from './paths';

const IS_WINDOWS = process.platform === 'win32';
/** How long to wait for stdio to close after killing the tree before giving up on it. */
const KILL_GRACE_MS = 2000;

/** Keeps the first and last `limit / 2` bytes of a stream, counting what it drops. */
class OutputCollector {
  private readonly head: Buffer[] = [];
  private headBytes = 0;
  private tail = Buffer.alloc(0);
  private dropped = 0;
  private readonly half: number;

  constructor(limit: number) {
    this.half = Math.max(1, Math.floor(limit / 2));
  }

  push(chunk: Buffer): void {
    const room = this.half - this.headBytes;
    if (room > 0) {
      this.head.push(chunk.subarray(0, room));
      this.headBytes += Math.min(room, chunk.length);
      chunk = chunk.subarray(room);
    }
    if (chunk.length === 0) return;
    const merged = Buffer.concat([this.tail, chunk]);
    const excess = Math.max(0, merged.length - this.half);
    this.dropped += excess;
    this.tail = merged.subarray(excess);
  }

  text(): string {
    const marker = this.dropped > 0 ? `\n... [${this.dropped} bytes omitted] ...\n` : '';
    return Buffer.concat(this.head).toString('utf8') + marker + this.tail.toString('utf8');
  }
}

/** Kills `child` and every process it started. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (IS_WINDOWS) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.on('error', () => child.kill());
    return;
  }
  try {
    // The child was spawned detached, so it leads its own process group.
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/** Options for {@link runShellCommand}. */
export interface RunShellOptions {
  shell: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes: number;
}

/** One running command; resolves once, however it ends. */
class ShellRun {
  private readonly stdout: OutputCollector;
  private readonly stderr: OutputCollector;
  private killedBy?: 'timeout' | 'abort';
  private done = false;
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly onAbort = () => this.kill('abort');

  constructor(
    private readonly child: ChildProcess,
    private readonly opts: RunShellOptions,
    private readonly resolve: (result: ShellExecResult) => void,
    private readonly reject: (error: Error) => void
  ) {
    this.stdout = new OutputCollector(opts.maxOutputBytes);
    this.stderr = new OutputCollector(opts.maxOutputBytes);
  }

  start(): void {
    this.child.stdout?.on('data', (chunk: Buffer) => this.stdout.push(chunk));
    this.child.stderr?.on('data', (chunk: Buffer) => this.stderr.push(chunk));
    this.child.on('error', (error) => this.fail(error));
    this.child.on('close', (code) => this.finish(code));
    if (this.opts.timeoutMs !== undefined) {
      this.timers.push(setTimeout(() => this.kill('timeout'), this.opts.timeoutMs));
    }
    this.opts.signal?.addEventListener('abort', this.onAbort, { once: true });
  }

  private kill(reason: 'timeout' | 'abort'): void {
    if (this.done || this.killedBy) return;
    this.killedBy = reason;
    killTree(this.child);
    // A grandchild that escaped the tree could hold stdio open forever.
    this.timers.push(
      setTimeout(() => {
        this.child.stdout?.destroy();
        this.child.stderr?.destroy();
        this.finish(null);
      }, KILL_GRACE_MS)
    );
  }

  private cleanup(): boolean {
    if (this.done) return false;
    this.done = true;
    this.timers.forEach(clearTimeout);
    this.opts.signal?.removeEventListener('abort', this.onAbort);
    return true;
  }

  private fail(error: Error): void {
    if (this.cleanup()) this.reject(new WorkspaceError(`Could not start the command: ${error.message}`));
  }

  private finish(code: number | null): void {
    if (!this.cleanup()) return;
    this.resolve({
      stdout: this.stdout.text(),
      stderr: this.stderr.text(),
      exitCode: this.killedBy ? null : code,
      timedOut: this.killedBy === 'timeout',
      ...(this.killedBy === 'abort' && { aborted: true }),
    });
  }
}

/**
 * Runs `command` through `opts.shell` and resolves with its (capped) output.
 * Resolves for any exit code, a timeout or an abort; rejects only when the
 * shell cannot be started.
 */
export function runShellCommand(command: string, opts: RunShellOptions): Promise<ShellExecResult> {
  if (opts.signal?.aborted) {
    return Promise.resolve({ stdout: '', stderr: '', exitCode: null, timedOut: false, aborted: true });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: opts.shell,
      cwd: opts.cwd,
      env: opts.env,
      detached: !IS_WINDOWS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    new ShellRun(child, opts, resolve, reject).start();
  });
}
