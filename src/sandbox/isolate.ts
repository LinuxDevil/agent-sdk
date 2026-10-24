/**
 * The `'isolate'` driver: `isolated-vm`, a V8 isolate inside the host
 * process.
 *
 * - The package is an OPTIONAL peer, loaded on the first `run()` through
 *   `loadOptionalPeer()`: importing the SDK never touches it, and a missing
 *   install becomes a `MissingPeerDependencyError` naming `npm install
 *   isolated-vm`.
 * - One isolate per `run()`: `Isolate({ memoryLimit })` caps its heap, the
 *   `evalClosure` `timeout` interrupts synchronous code and a wall-clock
 *   timer disposes the isolate on `timeoutMs` (the eval timeout does not
 *   apply while the code awaits), then the isolate is disposed either way.
 *   Arguments cross in and the result back by structured clone
 *   (`arguments: { copy }`, `result: { copy, promise }`).
 * - Boundary failures map to {@link SandboxError} kinds: our own timer's
 *   kill is 'timeout', an isolate disposed by the engine (the memory limit)
 *   is 'oom' and a driver setup failure is 'driver'. An error the code
 *   threw crosses unchanged.
 *
 * `isolate` is an EXECUTION boundary, not a security boundary: the isolate
 * shares the host process and an OOM can take the host down. Do not run
 * code you would not run yourself; truly hostile code needs a container
 * driver ('docker' / 'e2b', reserved names in {@link sandbox}).
 */

import type * as ivm from 'isolated-vm';
import { lazyValue, loadOptionalPeer, MissingPeerDependencyError } from '../providers/optionalPeer';
import { SandboxError } from './errors';
import type { SandboxCallOptions, SandboxDriver } from './types';

/** The resource guards of the 'isolate' driver (see `SandboxOptions`). */
export interface IsolateLimits {
  memoryMb: number;
  timeoutMs: number;
}

/** The limits a sandbox that does not set its own gets. */
export const ISOLATE_DEFAULTS: IsolateLimits = { memoryMb: 128, timeoutMs: 5_000 };

/** The driver name reported as `sandbox.driver` and on SandboxError.driver. */
const DRIVER = 'isolate';

/** The `isolated-vm` module surface this driver uses (the ambient declaration in typings/; the real package's types fill in when installed). */
type IvmModule = typeof import('isolated-vm');

/**
 * The module, loaded on first `run()`; a failed load retries next call
 * (`lazyValue` does not cache a rejection). The missing-peer error names the
 * driver and the alternative, not just the package.
 */
const loadIvm = lazyValue(async (): Promise<IvmModule> => {
  try {
    return await loadOptionalPeer('isolated-vm', () => import('isolated-vm'));
  } catch (error) {
    if (error instanceof MissingPeerDependencyError) {
      throw new MissingPeerDependencyError('isolated-vm', error.installCommand, {
        cause: error,
        feature: "the 'isolate' sandbox driver (sandbox({ driver: 'isolate' }) / defineTool({ sandbox }))",
        note: 'install it, or pass another SandboxDriver instead',
      });
    }
    throw error;
  }
});

/**
 * The context body `run()` evaluates: the caller's `code` arrives as `$0` and
 * its args as `$1`. `code` must evaluate to a function, called with those
 * args; its (possibly promised) value is the run's result, cloned back.
 */
const CALLER = `
const fn = eval('(' + $0 + ')');
if (typeof fn !== 'function') {
  throw new TypeError('sandbox run() code must evaluate to a function; the driver calls it with the given args');
}
return fn.apply(undefined, $1);
`;

async function runIsolated(module: IvmModule, limits: IsolateLimits, code: string, opts?: SandboxCallOptions): Promise<unknown> {
  let isolate: ivm.Isolate;
  try {
    isolate = new module.Isolate({ memoryLimit: limits.memoryMb });
  } catch (error) {
    throw new SandboxError(
      `the '${DRIVER}' driver could not create an isolate with memoryMb ${limits.memoryMb}`,
      'driver',
      DRIVER,
      { cause: error }
    );
  }
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The run is bounded twice: the eval `timeout` interrupts synchronous code,
  // and this timer disposes the isolate (rejecting a still-pending eval, like
  // one awaiting a promise the eval timeout does not cover).
  const stopped = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      isolate.dispose();
      reject(new SandboxError(`the sandboxed run exceeded timeoutMs (${limits.timeoutMs} ms)`, 'timeout', DRIVER));
    }, limits.timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  });
  stopped.catch(() => undefined);
  try {
    const context = await isolate.createContext();
    return await Promise.race([
      context.evalClosure(CALLER, [code, opts?.args ?? []], {
        arguments: { copy: true },
        result: { copy: true, promise: true },
        timeout: limits.timeoutMs,
      }),
      stopped,
    ]);
  } catch (error) {
    // Our timer disposed the isolate: the run outlasted timeoutMs.
    if (timedOut) {
      throw new SandboxError(`the sandboxed run exceeded timeoutMs (${limits.timeoutMs} ms)`, 'timeout', DRIVER, { cause: error });
    }
    // The engine disposed it otherwise: the memory cap is the only configured
    // limit, so a dead isolate means an OOM (or a crash we report the same way).
    if (isolate.isDisposed) {
      throw new SandboxError(
        `the sandboxed run exceeded the isolate's memory limit (memoryMb ${limits.memoryMb}) or crashed it`,
        'oom',
        DRIVER,
        { cause: error }
      );
    }
    // The code's own error crosses unchanged (it is not a boundary failure).
    throw error instanceof Error ? error : new Error(typeof error === 'string' ? error : String(error));
  } finally {
    clearTimeout(timer);
    if (!isolate.isDisposed) {
      try {
        isolate.dispose();
      } catch {
        // A catastrophically failed isolate is already gone.
      }
    }
  }
}

/**
 * The driver against an explicit `isolated-vm` module - what a test injects
 * so the suite never needs the native package. `sandbox()` and
 * `defineTool({ sandbox })` use {@link isolateDriver}, which lazy-loads it.
 */
export function createIsolateDriver(module: IvmModule, limits: IsolateLimits): SandboxDriver {
  return {
    name: DRIVER,
    run: (code, opts) => runIsolated(module, limits, code, opts),
  };
}

/**
 * The `'isolate'` driver `sandbox({ driver: 'isolate' })` builds. Constructing
 * it does not load `isolated-vm`; the first `run()` does
 * (`MissingPeerDependencyError` when the optional peer is not installed).
 */
export function isolateDriver(limits: IsolateLimits): SandboxDriver {
  return {
    name: DRIVER,
    run: async (code, opts) => runIsolated(await loadIvm(), limits, code, opts),
  };
}
