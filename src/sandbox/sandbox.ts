/**
 * `sandbox()` - the public API of the code-sandbox seam (spec
 * 0001-sandboxing). A driver runs a function's source in an isolated
 * context with a result channel; v1 ships `'isolate'` (isolated-vm, an
 * optional peer) and reserves `'docker'`/`'e2b'`.
 *
 * @example
 * ```ts
 * const box = sandbox({ driver: 'isolate', memoryMb: 128, timeoutMs: 5_000 });
 * const result = await box.run('(input) => input * 2', { args: [21] });
 * ```
 */

import { SDKError } from '../utils/sdkError';
import { SandboxError } from './errors';
import { ISOLATE_DEFAULTS, isolateDriver } from './isolate';
import type { Sandbox, SandboxCallOptions, SandboxDriver, SandboxDriverRef, SandboxOptions } from './types';

/** The resource limits a box passes to a limit-aware driver. */
interface SandboxLimits {
  memoryMb: number;
  timeoutMs: number;
}

function positive(value: unknown, name: string): void {
  if (value !== undefined && !(typeof value === 'number' && Number.isFinite(value) && value > 0)) {
    throw new SDKError(`sandbox(): '${name}' must be a positive number, got ${String(value)}`, 'LOUSHO_CONFIG_INVALID');
  }
}

/** The driver for a name or instance; reserved names and anything else fail at construction. */
function resolveDriver(ref: SandboxDriverRef, limits: SandboxLimits): SandboxDriver {
  if (ref === 'isolate') return isolateDriver(limits);
  if (ref === 'docker' || ref === 'e2b') {
    throw new SDKError(
      `sandbox(): driver '${ref}' is reserved but not yet implemented - pass a SandboxDriver instance, or use 'isolate'`,
      'LOUSHO_CONFIG_INVALID'
    );
  }
  if (typeof ref === 'object' && ref !== null && typeof ref.run === 'function') return ref;
  throw new SDKError(
    `sandbox(): 'driver' must be 'isolate' or a SandboxDriver ({ run(code, { args }) }), got ${typeof ref === 'string' ? `'${ref}'` : String(ref)}`,
    'LOUSHO_CONFIG_INVALID'
  );
}

/**
 * A wall-clock cap around `driver.run()` for one call. Drivers that can stop
 * a run enforce `timeoutMs` themselves (isolate disposes the isolate); this
 * race reports the same `kind: 'timeout'` for a driver that cannot, whose
 * run may then still be settling in the background.
 */
function raceTimeout(name: string, limits: SandboxLimits, code: string, opts: SandboxCallOptions | undefined, run: SandboxDriver['run']): Promise<unknown> {
  const pending = run(code, opts);
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new SandboxError(`the sandboxed run exceeded timeoutMs (${limits.timeoutMs} ms)`, 'timeout', name)),
      limits.timeoutMs
    );
    pending.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * Build a sandbox: a bound driver whose `run(code, { args })` evaluates
 * `code` to a function, calls it with `args` and resolves with the cloned
 * result. Code, args and result cross the boundary by structured clone -
 * every value must be cloneable.
 *
 * `{ driver: 'isolate' }` runs code in a V8 isolate (the optional
 * `isolated-vm` peer - install it to use it). `'docker'` and `'e2b'` are
 * reserved names: passing one throws "not yet implemented".
 *
 * The `'isolate'` driver is an execution boundary, NOT a security boundary:
 * the isolate shares the host process and an OOM can take the host down. Do
 * not run code you would not run yourself.
 */
export function sandbox(options: SandboxOptions): Sandbox {
  const opts = (options ?? {}) as SandboxOptions;
  positive(opts.memoryMb, 'memoryMb');
  positive(opts.timeoutMs, 'timeoutMs');
  const limits: SandboxLimits = {
    memoryMb: opts.memoryMb ?? ISOLATE_DEFAULTS.memoryMb,
    timeoutMs: opts.timeoutMs ?? ISOLATE_DEFAULTS.timeoutMs,
  };
  if (opts.driver === undefined) {
    throw new SDKError("sandbox(): 'driver' is required - 'isolate', a SandboxDriver instance, or (reserved) 'docker'/'e2b'", 'LOUSHO_CONFIG_INVALID');
  }
  const driver = resolveDriver(opts.driver, limits);
  const name = driver.name ?? 'custom';
  return {
    driver: name,
    run: (code, callOpts) => raceTimeout(name, limits, code, callOpts, (c, o) => driver.run(c, o)),
  };
}
