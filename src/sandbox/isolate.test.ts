/**
 * The 'isolate' driver against an injected `isolated-vm` module, so the
 * timeout/OOM/driver mapping and the memory/timeout forwarding are tested
 * without the native package.
 */
import { describe, it, expect } from 'vitest';
import { createIsolateDriver, ISOLATE_DEFAULTS } from './isolate';
import { SandboxError } from './errors';

type EvalCall = { code: string; args: unknown[]; options?: { arguments?: { copy?: boolean }; result?: { copy?: boolean; promise?: boolean }; timeout?: number } };

interface FakeModuleOptions {
  /** What evalClosure does once called (default: evaluate the caller body like a real context). */
  eval?: (isolate: FakeIsolate, code: string, args: unknown[]) => unknown;
  /** Throw instead of constructing. */
  constructError?: unknown;
}

class FakeIsolate {
  static created: Array<{ memoryLimit?: number }> = [];
  disposed = false;
  evalCalls: EvalCall[] = [];
  constructor(opts?: { memoryLimit?: number }, private behavior?: FakeModuleOptions) {
    if (behavior?.constructError) throw behavior.constructError;
    FakeIsolate.created.push(opts ?? {});
  }
  get isDisposed(): boolean {
    return this.disposed;
  }
  dispose(): void {
    this.disposed = true;
  }
  async createContext() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const isolate = this;
    return {
      evalCalls: this.evalCalls,
      async evalClosure(code: string, args: unknown[], options?: EvalCall['options']) {
        isolate.evalCalls.push({ code, args: args ?? [], options });
        if (isolate.behavior?.eval) return isolate.behavior.eval(isolate, code, args ?? []);
        // What the real context does: run the caller body with $0/$1 bound,
        // clone the args in, await the result, clone it back.
        const [a, b] = (args ?? []).map((value) => (options?.arguments?.copy ? structuredClone(value) : value));
        const run = new Function('$0', '$1', code) as ($0: unknown, $1: unknown) => unknown;
        const result = await run(a, b);
        return options?.result?.copy ? structuredClone(result) : result;
      },
    };
  }
}

function fakeModule(behavior?: FakeModuleOptions): { module: never; isolates: typeof FakeIsolate.created } {
  FakeIsolate.created = [];
  class Bound extends FakeIsolate {
    constructor(opts?: { memoryLimit?: number }) {
      super(opts, behavior);
    }
  }
  return { module: { Isolate: Bound } as never, isolates: FakeIsolate.created };
}

const LIMITS = { memoryMb: 64, timeoutMs: 5_000 };

describe('createIsolateDriver', () => {
  it('creates an isolate with memoryLimit and evaluates the source with cloned args', async () => {
    const { module, isolates } = fakeModule();
    const driver = createIsolateDriver(module, LIMITS);

    const result = await driver.run('(args, ctx) => ({ sum: args.a + args.b, id: ctx.toolCallId })', {
      args: [{ a: 1, b: 2 }, { toolCallId: 'call_1' }],
    });

    expect(result).toEqual({ sum: 3, id: 'call_1' });
    expect(isolates).toEqual([{ memoryLimit: 64 }]);
    expect(driver.name).toBe('isolate');
  });

  it('forwards timeoutMs to evalClosure and disposes the isolate afterwards', async () => {
    let last: FakeIsolate | undefined;
    const { module } = fakeModule({
      eval: (isolate, code, args) => {
        last = isolate;
        const [a, b] = args;
        const run = new Function('$0', '$1', code) as ($0: unknown, $1: unknown) => unknown;
        return run(a, b);
      },
    });
    const driver = createIsolateDriver(module, LIMITS);

    await driver.run('() => "done"');

    expect(last?.evalCalls[0].options).toMatchObject({
      arguments: { copy: true },
      result: { copy: true, promise: true },
      timeout: 5000,
    });
    expect(last?.disposed).toBe(true);
  });

  it('maps the wall-clock timeout to a timeout SandboxError', async () => {
    const { module } = fakeModule({ eval: () => new Promise(() => undefined) });
    const driver = createIsolateDriver(module, { memoryMb: 64, timeoutMs: 25 });

    const error = await driver.run('() => 1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxError);
    expect(error).toMatchObject({ kind: 'timeout', driver: 'isolate' });
  });

  it('maps an engine-disposed isolate to an oom SandboxError', async () => {
    const { module } = fakeModule({
      eval: (isolate) => {
        isolate.dispose();
        throw new Error('isolate was disposed');
      },
    });
    const driver = createIsolateDriver(module, LIMITS);

    await expect(driver.run('() => 1')).rejects.toMatchObject({ kind: 'oom', driver: 'isolate' });
  });

  it('maps a construction failure to a driver SandboxError', async () => {
    const { module } = fakeModule({ constructError: new Error('no isolates for you') });
    const driver = createIsolateDriver(module, LIMITS);

    await expect(driver.run('() => 1')).rejects.toMatchObject({ kind: 'driver', driver: 'isolate' });
  });

  it("passes the code's own error through unchanged", async () => {
    const { module } = fakeModule();
    const driver = createIsolateDriver(module, LIMITS);

    await expect(driver.run('() => { throw new RangeError("the code failed") }')).rejects.toBeInstanceOf(RangeError);
  });
});

describe('ISOLATE_DEFAULTS', () => {
  it('are the guards a sandbox without its own gets', () => {
    expect(ISOLATE_DEFAULTS).toEqual({ memoryMb: 128, timeoutMs: 5_000 });
  });
});
