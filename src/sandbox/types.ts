/**
 * The types of the code-sandbox seam. A {@link SandboxDriver} runs a piece of
 * code in an isolated context and resolves with its result; {@link sandbox}
 * and `defineTool({ sandbox })` build on it.
 *
 * This module is types plus one pure helper and imports nothing, so any part
 * of the SDK (tool descriptors, span attributes) can reference it without
 * pulling a driver implementation.
 */

/**
 * Why a sandboxed run failed at the boundary - the `sandbox.error` span
 * attribute values: 'timeout' (the run outlasted `timeoutMs`), 'oom' (the
 * driver killed it for its memory cap) or 'driver' (the driver itself
 * failed). An error the sandboxed code threw is not a boundary failure and
 * carries none of these.
 */
export type SandboxErrorKind = 'timeout' | 'oom' | 'driver';

/** Per-call options of {@link SandboxDriver.run} and {@link Sandbox.run}. */
export interface SandboxCallOptions {
  /**
   * The arguments the code's function is called with, in order. Every value
   * crosses the boundary by structured clone, so each must be cloneable:
   * plain JSON values, ArrayBuffer and typed arrays, Date, Map, Set, ... -
   * never functions, class instances, AbortSignal or other live references.
   */
  args?: unknown[];
}

/**
 * A driver runs `code` in its isolated context. `code` evaluates to a
 * function (an arrow, `function` or `async function` expression), which the
 * driver calls with `opts.args` (`[]` when absent); `run()` resolves with
 * what it returns - a promise it returns is awaited - cloned back across the
 * boundary, so the value must be structured-cloneable.
 *
 * A driver reports a boundary failure - a timeout, a memory-limit kill or
 * its own fault - as a {@link SandboxError} whose `kind` names it; an error
 * the code itself throws crosses as itself (it is a tool error, not a
 * boundary failure).
 */
export interface SandboxDriver {
  /**
   * The driver's name, recorded on tool spans as `sandbox.driver`. A driver
   * instance without one reports `'custom'`.
   */
  readonly name?: string;
  run(code: string, opts?: SandboxCallOptions): Promise<unknown>;
}

/** The drivers {@link sandbox} knows by name. `'docker'` and `'e2b'` are reserved: naming one errors "not yet implemented". */
export type SandboxDriverName = 'isolate' | 'docker' | 'e2b';

/** What `sandbox({ driver })` and `defineTool({ sandbox: { driver } })` take: a {@link SandboxDriverName} or a driver instance. */
export type SandboxDriverRef = SandboxDriverName | SandboxDriver;

/** Options of {@link sandbox}. */
export interface SandboxOptions {
  /**
   * Which driver runs the code: `'isolate'` (the default elsewhere - V8
   * isolates via the optional `isolated-vm` peer), a {@link SandboxDriver}
   * instance, or a reserved name (`'docker'`, `'e2b'`) which errors
   * "not yet implemented".
   */
  driver: SandboxDriverRef;
  /**
   * Heap cap for one run, in MB, enforced by the driver when it supports one
   * (`'isolate'` does). A breach fails the run with `kind: 'oom'` - and can
   * take the host process: `isolate` is an execution boundary, not a
   * security one.
   */
  memoryMb?: number;
  /**
   * Wall-clock cap of one run, in ms; a run still going then fails with
   * `kind: 'timeout'`. Drivers that can stop the run do so (`isolate`
   * disposes the isolate); for a custom driver the box reports the timeout
   * while the run itself may still be settling in the background.
   */
  timeoutMs?: number;
}

/** What {@link sandbox} returns: a bound driver ready for `run()` calls. */
export interface Sandbox {
  /** The resolved driver name: `'isolate'`, or the driver instance's `name`. */
  readonly driver: string;
  run(code: string, opts?: SandboxCallOptions): Promise<unknown>;
}

/**
 * `defineTool({ sandbox })`: run the tool's `execute` inside a code sandbox.
 * The contract (what crosses the boundary, which `ctx` fields survive) is on
 * {@link import('../types').ToolDescriptor.sandbox}.
 */
export interface ToolSandboxOptions {
  /** Default `'isolate'`; `'docker'` and `'e2b'` are reserved and error "not yet implemented". */
  driver?: SandboxDriverRef;
  /** The driver's heap cap for one call, in MB (see {@link SandboxOptions.memoryMb}). */
  memoryMb?: number;
  /** Wall-clock cap of one call, in ms (see {@link SandboxOptions.timeoutMs}). */
  timeoutMs?: number;
}

/** The `sandbox.driver` attribute value for a sandbox option's driver (`'isolate'` when unset). */
export function sandboxDriverName(driver: SandboxDriverRef | undefined): string {
  if (driver === undefined) return 'isolate';
  return typeof driver === 'string' ? driver : driver.name ?? 'custom';
}
