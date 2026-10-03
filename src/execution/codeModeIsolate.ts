/**
 * N14: runs one code-mode script (the body of `run_code`) in a QuickJS
 * WebAssembly isolate from the optional peer `quickjs-emscripten`.
 *
 * - One runtime and context per script, with a memory limit, a stack limit
 *   and an interrupt handler for the deadline; disposed when the script ends.
 *   The WebAssembly module is loaded once per process (`loadQuickJS()`).
 * - The isolate has only the language itself: no `require`, `process`,
 *   `fetch`, timers, module loading or host objects. The script reaches the
 *   host through two functions installed by a trusted prelude (which removes
 *   them from the global object): one tool call and one log line. Values cross
 *   the boundary as JSON strings only.
 * - The host drives the isolate: `executePendingJobs()` after each settled
 *   tool call, until the script's promise settles.
 *
 * A script that computes without awaiting runs on the host's thread: it blocks
 * the event loop until it ends or `timeoutMs` interrupts it.
 */

import type { QuickJSContext, QuickJSDeferredPromise, QuickJSHandle, QuickJSRuntime, QuickJSWASMModule } from 'quickjs-emscripten';
import { lazyValue, loadOptionalPeer } from '../providers/optionalPeer';

/** The limits of one script (see `CodeModeOptions`). */
export interface ScriptLimits {
  timeoutMs: number;
  memoryLimitBytes: number;
  maxToolCalls: number;
  maxOutputChars: number;
}

/** What a tool call from the script settled with: a JSON result, or an error message the script sees. */
export type ScriptToolResult = { json: string } | { error: string };

/** The host side of a script. */
export interface ScriptHost {
  /** Names on the script's `tools` object. */
  toolNames: readonly string[];
  /**
   * Runs one tool call. Resolves with what the script sees; a rejection is a
   * host failure (a guardrail block, a hook error) that ends the script and
   * is rethrown by {@link runScript}.
   */
  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ScriptToolResult>;
  /** The run's signal: aborting it stops the script. */
  signal?: AbortSignal;
}

/** What a finished script returned. */
export interface ScriptResult {
  result: unknown;
  logs: string[];
  toolCalls: number;
}

/** Why a script stopped without a result: the message names the cause (it becomes `run_code`'s tool error). */
export class ScriptError extends Error {
  constructor(
    message: string,
    readonly cause_: 'error' | 'timeout' | 'memory' | 'tool-calls' | 'output' | 'aborted'
  ) {
    super(message);
    this.name = 'ScriptError';
  }
}

const MAX_STACK_BYTES = 512 * 1024;
/** The file name of the prelude in the isolate's stack traces. */
const PRELUDE_FILE = 'run_code.js';
/** How many settled tool calls a script error lists, and how long each part may be. */
const TRAIL_CALLS = 5;
const TRAIL_CHARS = 200;

function clip(text: string): string {
  return text.length > TRAIL_CHARS ? `${text.slice(0, TRAIL_CHARS)}...` : text;
}
const LOG_TRUNCATED = '[logs truncated: maxOutputChars reached]';

/**
 * The prelude: takes the two host functions off the global object, builds the
 * frozen `tools` and `console` objects and compiles the script as the body of
 * an async function `(tools, console)`. Resolves with the result as JSON.
 */
function prelude(code: string, toolNames: readonly string[]): string {
  return `(() => {
  const call = globalThis.__lousho_call;
  const log = globalThis.__lousho_log;
  delete globalThis.__lousho_call;
  delete globalThis.__lousho_log;
  const text = (value) => {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return String(value);
    try { const json = JSON.stringify(value); return json === undefined ? String(value) : json; } catch { return String(value); }
  };
  const line = (level) => (...args) => { log(level, args.map(text).join(' ')); };
  const console = Object.freeze({ log: line('log'), info: line('info'), warn: line('warn'), error: line('error'), debug: line('debug') });
  const tools = Object.create(null);
  for (const name of ${JSON.stringify(toolNames)}) {
    tools[name] = async (args) => {
      const json = JSON.stringify(args === undefined ? {} : args);
      if (json === undefined) throw new TypeError('tools.' + name + '() takes one JSON-serializable object argument');
      return JSON.parse(await call(name, json));
    };
  }
  Object.freeze(tools);
  const AsyncFunction = (async () => {}).constructor;
  return (async () => {
    const run = new AsyncFunction('tools', 'console', ${JSON.stringify(code)});
    const value = await run(tools, console);
    const json = JSON.stringify(value === undefined ? null : value);
    if (json === undefined) throw new TypeError('the return value is not JSON-serializable');
    return json;
  })();
})()`;
}

/** Loads the QuickJS WebAssembly module (release, sync variant) once per process; a failed load is retried next time. */
const loadModule = lazyValue(async (): Promise<QuickJSWASMModule> => {
  const quickjs = await loadOptionalPeer('quickjs-emscripten', () => import('quickjs-emscripten'));
  return quickjs.newQuickJSWASMModule();
});

/** The QuickJS module, loaded on first use (`MissingPeerDependencyError` without `quickjs-emscripten`). */
export function loadQuickJS(): Promise<QuickJSWASMModule> {
  return loadModule();
}

/** One script in its own runtime and context. */
class Script {
  private readonly runtime: QuickJSRuntime;
  private readonly context: QuickJSContext;
  private readonly controller = new AbortController();
  private readonly deadline: number;
  private readonly logs: string[] = [];
  private logChars = 0;
  private calls = 0;
  /** The first settled tool calls, shown with a script error so the model can see the results' shapes. */
  private readonly trail: string[] = [];
  /** Host calls not settled yet, and the deferred promises the script awaits for them. */
  private readonly inFlight = new Set<Promise<void>>();
  private readonly deferreds = new Set<QuickJSDeferredPromise>();
  /** Set when the script must stop whatever it does (a limit, an abort, a host failure). */
  private stop?: { error: unknown };
  private wake?: () => void;

  constructor(
    module: QuickJSWASMModule,
    private readonly host: ScriptHost,
    private readonly limits: ScriptLimits
  ) {
    this.deadline = Date.now() + limits.timeoutMs;
    this.runtime = module.newRuntime({
      memoryLimitBytes: limits.memoryLimitBytes,
      maxStackSizeBytes: MAX_STACK_BYTES,
      interruptHandler: () => this.interrupted(),
    });
    this.context = this.runtime.newContext();
  }

  /** Whether the isolate must stop now (the interrupt handler; also checked between jobs). */
  private interrupted(): boolean {
    if (this.stop) return true;
    if (this.host.signal?.aborted) this.halt(new ScriptError('run_code was aborted: the run was cancelled.', 'aborted'));
    else if (Date.now() > this.deadline) this.halt(timeoutError(this.limits.timeoutMs));
    return this.stop !== undefined;
  }

  private halt(error: unknown): void {
    this.stop ??= { error };
    this.controller.abort(error);
    this.wake?.();
  }

  async run(code: string): Promise<ScriptResult> {
    try {
      this.install();
      const json = await this.settle(code);
      return this.finish(json);
    } finally {
      this.halt(new ScriptError('run_code ended.', 'aborted'));
      // Every host call the script started settles before the isolate goes away.
      await Promise.all(this.inFlight);
      this.dispose();
    }
  }

  /** The two host functions the prelude takes. */
  private install(): void {
    const { context } = this;
    const call = context.newFunction('__lousho_call', (nameHandle, argsHandle) => this.startCall(context.getString(nameHandle), context.getString(argsHandle)));
    context.setProp(context.global, '__lousho_call', call);
    call.dispose();
    const log = context.newFunction('__lousho_log', (levelHandle, textHandle) => {
      this.log(context.getString(levelHandle), context.getString(textHandle));
    });
    context.setProp(context.global, '__lousho_log', log);
    log.dispose();
  }

  /** Starts a host tool call for the script; returns the promise handle the script awaits. */
  private startCall(name: string, argsJson: string): QuickJSHandle {
    const deferred = this.context.newPromise();
    this.deferreds.add(deferred);
    this.calls++;
    if (this.calls > this.limits.maxToolCalls) {
      const error = new ScriptError(`run_code stopped: the script made more than maxToolCalls (${this.limits.maxToolCalls}) tool calls.`, 'tool-calls');
      this.halt(error);
      this.reject(deferred, error.message);
      return deferred.handle;
    }
    const args = parseArgs(argsJson);
    if (!args || !this.host.toolNames.includes(name)) {
      this.reject(deferred, args ? `tools.${name} is not a tool this script can call.` : `tools.${name}() takes one object argument.`);
      return deferred.handle;
    }
    const settled = this.host.callTool(name, args, this.controller.signal).then(
      (outcome) => {
        this.remember(name, argsJson, outcome);
        if ('json' in outcome) this.resolve(deferred, outcome.json);
        else this.reject(deferred, outcome.error);
      },
      (error: unknown) => this.halt(new HostFailure(error))
    );
    const tracked = settled.finally(() => {
      this.inFlight.delete(tracked);
      this.wake?.();
    });
    this.inFlight.add(tracked);
    return deferred.handle;
  }

  private remember(name: string, argsJson: string, outcome: ScriptToolResult): void {
    if (this.trail.length >= TRAIL_CALLS) return;
    const settled = 'json' in outcome ? `returned ${clip(outcome.json)}` : `threw ${clip(outcome.error)}`;
    this.trail.push(`- tools.${name}(${clip(argsJson)}) ${settled}`);
  }

  private resolve(deferred: QuickJSDeferredPromise, json: string): void {
    if (this.stop || !deferred.alive) return;
    const value = this.context.newString(json);
    deferred.resolve(value);
    value.dispose();
    this.deferreds.delete(deferred);
  }

  private reject(deferred: QuickJSDeferredPromise, message: string): void {
    if (!deferred.alive) return;
    const error = this.context.newError({ name: 'ToolError', message });
    deferred.reject(error);
    error.dispose();
    this.deferreds.delete(deferred);
  }

  private log(level: string, text: string): void {
    if (this.logChars >= this.limits.maxOutputChars) return;
    const line = level === 'log' || level === 'info' ? text : `[${level}] ${text}`;
    const room = this.limits.maxOutputChars - this.logChars;
    this.logs.push(line.length > room ? `${line.slice(0, room)} ${LOG_TRUNCATED}` : line);
    this.logChars += Math.min(line.length, room);
  }

  /** Evaluates the prelude and drives the isolate until the script's promise settles; resolves with its JSON. */
  private async settle(code: string): Promise<string> {
    const { context, runtime } = this;
    const evaluated = context.evalCode(prelude(code, this.host.toolNames), PRELUDE_FILE);
    if (evaluated.error) throw this.scriptFailure(this.consume(evaluated.error));
    const promise = evaluated.value;
    try {
      for (;;) {
        const jobs = runtime.executePendingJobs();
        if (jobs.error) throw this.scriptFailure(this.consume(jobs.error));
        if (this.stop) throw this.stop.error;
        const state = context.getPromiseState(promise);
        if (state.type === 'fulfilled') {
          const value = this.consume(state.value);
          if (typeof value !== 'string') throw new ScriptError('run_code failed: the script did not return a value.', 'error');
          return value;
        }
        if (state.type === 'rejected') throw this.scriptFailure(this.consume(state.error));
        if (this.inFlight.size === 0) {
          throw new ScriptError('run_code failed: the script is waiting for a promise that never settles (only tool calls can be awaited).', 'error');
        }
        await this.nextEvent();
      }
    } finally {
      promise.dispose();
    }
  }

  /** Waits until a host call settles, the deadline passes or the run is aborted. */
  private nextEvent(): Promise<void> {
    return new Promise<void>((resolve) => {
      const check = () => {
        this.interrupted();
        done();
      };
      const done = () => {
        clearTimeout(timer);
        this.host.signal?.removeEventListener('abort', check);
        this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(check, Math.max(0, this.deadline - Date.now()) + 1);
      this.host.signal?.addEventListener('abort', check);
      this.wake = done;
    });
  }

  /** Dumps a handle to a host value and disposes it. */
  private consume(handle: QuickJSHandle): unknown {
    try {
      return this.context.dump(handle);
    } finally {
      handle.dispose();
    }
  }

  /** The error for something the isolate threw: a limit that stopped it, or the script's own error. */
  private scriptFailure(thrown: unknown): unknown {
    if (this.stop) return this.stop.error;
    const { name, message, stack } = (typeof thrown === 'object' && thrown !== null ? thrown : {}) as { name?: unknown; message?: unknown; stack?: unknown };
    if (name === 'InternalError' && message === 'out of memory') {
      return new ScriptError(`run_code stopped: the script used more than memoryLimitBytes (${this.limits.memoryLimitBytes} bytes).`, 'memory');
    }
    if (name === 'InternalError' && message === 'interrupted') return timeoutError(this.limits.timeoutMs);
    const text = typeof message === 'string' ? `${typeof name === 'string' ? name : 'Error'}: ${message}` : String(thrown);
    // Frames of the script's own code only (the prelude's are not the model's).
    const where = typeof stack === 'string' ? stack.split('\n').filter((line) => line.trim() && !line.includes(PRELUDE_FILE)).slice(0, 3).join('\n') : '';
    const trail = this.trail.length > 0 ? `\nTool calls before the error:\n${this.trail.join('\n')}` : '';
    return new ScriptError(`run_code failed: the script threw ${text}${where ? `\n${where}` : ''}${trail}`, 'error');
  }

  /** The script's result, within `maxOutputChars` (the result first, then as many log characters as fit). */
  private finish(json: string): ScriptResult {
    const { maxOutputChars } = this.limits;
    if (json.length > maxOutputChars) {
      throw new ScriptError(
        `run_code failed: the script's return value is ${json.length} characters of JSON, over maxOutputChars (${maxOutputChars}). ` +
          'Return a smaller value: filter or summarize inside the script.',
        'output'
      );
    }
    return { result: JSON.parse(json) as unknown, logs: trimLogs(this.logs, maxOutputChars - json.length), toolCalls: this.calls };
  }

  private dispose(): void {
    for (const deferred of this.deferreds) if (deferred.alive) deferred.dispose();
    this.deferreds.clear();
    this.context.dispose();
    this.runtime.dispose();
  }
}

/** A host failure while the script ran (rethrown as is by {@link runScript}). */
class HostFailure {
  constructor(readonly error: unknown) {}
}

function timeoutError(timeoutMs: number): ScriptError {
  return new ScriptError(`run_code stopped: the script ran longer than timeoutMs (${timeoutMs} ms), counting the tool calls it waited for.`, 'timeout');
}

function parseArgs(json: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The first log lines that fit in `room` characters; a cut line is marked. */
function trimLogs(logs: string[], room: number): string[] {
  const kept: string[] = [];
  let left = room;
  for (const line of logs) {
    if (line.length <= left) {
      kept.push(line);
      left -= line.length;
      continue;
    }
    kept.push(left > 0 ? `${line.slice(0, left)} ${LOG_TRUNCATED}` : LOG_TRUNCATED);
    break;
  }
  return kept;
}

/**
 * Runs `code` in a fresh isolate of `module`. Resolves with the script's
 * result; rejects with a {@link ScriptError} naming why it stopped, or with
 * the host failure a tool call ended in (as is).
 */
export async function runScript(module: QuickJSWASMModule, code: string, host: ScriptHost, limits: ScriptLimits): Promise<ScriptResult> {
  try {
    return await new Script(module, host, limits).run(code);
  } catch (error) {
    throw error instanceof HostFailure ? error.error : error;
  }
}
