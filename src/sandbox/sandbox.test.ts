/**
 * sandbox(): the driver contract, structured-clone argument passing, the
 * timeout race and the error kinds - with an injected driver, so no native
 * `isolated-vm` is needed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { sandbox } from './sandbox';
import { SandboxError, sandboxErrorKind } from './errors';
import { sandboxDriverName, type SandboxDriver } from './types';
import { MissingPeerDependencyError } from '../providers/optionalPeer';
import { SDKError } from '../utils/sdkError';

function moduleNotFound(packageName: string): Error {
  return Object.assign(new Error(`Cannot find module '${packageName}'`), { code: 'MODULE_NOT_FOUND' });
}

afterEach(() => {
  vi.doUnmock('isolated-vm');
  vi.resetModules();
});

/**
 * A driver that simulates the boundary with host structured clones: args are
 * cloned in, the result back. `impl` lets a test observe or replace the call.
 */
function cloneDriver(impl?: (code: string, args: unknown[]) => unknown): SandboxDriver & { calls: Array<{ code: string; args: unknown[] }> } {
  const calls: Array<{ code: string; args: unknown[] }> = [];
  return {
    name: 'fake',
    calls,
    async run(code, opts) {
      const args = (opts?.args ?? []).map((value) => structuredClone(value));
      calls.push({ code, args });
      const result = impl ? await impl(code, args) : undefined;
      return structuredClone(result);
    },
  };
}

/** A driver that evaluates the code in-process the way 'isolate' does: `code` is a function's source, called with the args. */
function evalDriver(): SandboxDriver {
  return {
    name: 'eval-fake',
    async run(code, opts) {
      const args = (opts?.args ?? []).map((value) => structuredClone(value));
      const fn = new Function(`return (${code})`)() as (...args: unknown[]) => unknown;
      return structuredClone(await fn(...args));
    },
  };
}

describe('sandbox()', () => {
  it('runs code through the driver and returns its result', async () => {
    const box = sandbox({ driver: evalDriver() });
    expect(box.driver).toBe('eval-fake');
    await expect(box.run('(n) => n * 2', { args: [21] })).resolves.toBe(42);
  });

  it('structured-clones args in and the result back', async () => {
    const seen: unknown[] = [];
    const driver = cloneDriver((_code, args) => {
      seen.push(...args);
      (args[0] as { nested: { value: number } }).nested.value = 999;
      return { out: args[0] };
    });
    const box = sandbox({ driver });
    const input = { nested: { value: 1 }, when: new Date('2026-01-01T00:00:00Z') };

    const result = (await box.run('(x) => x', { args: [input] })) as { out: { nested: { value: number } } };

    expect(result.out.nested.value).toBe(999);
    // The caller's object was not the one mutated: the driver saw a clone.
    expect(input.nested.value).toBe(1);
    expect(seen[0]).not.toBe(input);
  });

  it('wraps a still-running call in a SandboxError of kind timeout after timeoutMs', async () => {
    const driver: SandboxDriver = { name: 'hang', run: () => new Promise(() => undefined) };
    const box = sandbox({ driver, timeoutMs: 30 });

    const error = await box.run('() => 1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxError);
    expect(error).toMatchObject({ kind: 'timeout', driver: 'hang', toolErrorKind: 'sandbox', code: 'LOUSHO_SANDBOX_FAILED' });
    expect(sandboxErrorKind(error)).toBe('timeout');
  });

  it('lets a driver-reported oom cross unchanged', async () => {
    const driver: SandboxDriver = {
      name: 'oomy',
      run: () => Promise.reject(new SandboxError('the isolate exceeded its memory limit', 'oom', 'oomy')),
    };
    const box = sandbox({ driver });

    await expect(box.run('() => 1')).rejects.toMatchObject({ kind: 'oom', driver: 'oomy' });
  });

  it('lets a driver-reported fault cross with kind driver', async () => {
    const driver: SandboxDriver = {
      name: 'broken',
      run: () => Promise.reject(new SandboxError('the sidecar refused', 'driver', 'broken')),
    };
    const box = sandbox({ driver });

    await expect(box.run('() => 1')).rejects.toMatchObject({ kind: 'driver' });
  });

  it("passes the code's own error through as an ordinary failure", async () => {
    const box = sandbox({ driver: evalDriver() });
    await expect(box.run('() => { throw new TypeError("inside") }')).rejects.toBeInstanceOf(TypeError);
  });

  it.each(['docker', 'e2b'] as const)("rejects reserved driver '%s' as not yet implemented", (driver) => {
    expect(() => sandbox({ driver })).toThrowError(SDKError);
    expect(() => sandbox({ driver })).toThrowError(/not yet implemented/);
  });

  it('requires a driver and positive limits', () => {
    expect(() => sandbox({} as never)).toThrowError(/'driver' is required/);
    expect(() => sandbox({ driver: evalDriver(), memoryMb: 0 })).toThrowError(/'memoryMb' must be a positive number/);
    expect(() => sandbox({ driver: evalDriver(), timeoutMs: -1 })).toThrowError(/'timeoutMs' must be a positive number/);
    expect(() => sandbox({ driver: 'nope' as never })).toThrowError(/'driver' must be 'isolate' or a SandboxDriver/);
  });

  it('defaults an unnamed driver instance to the custom name', () => {
    expect(sandbox({ driver: { run: async () => 1 } }).driver).toBe('custom');
  });

  it("lazy-loads isolated-vm on the first 'isolate' run and reports a missing peer clearly", async () => {
    vi.resetModules();
    vi.doMock('isolated-vm', () => {
      throw moduleNotFound('isolated-vm');
    });
    const { sandbox: freshSandbox } = await import('./sandbox');
    const box = freshSandbox({ driver: 'isolate' });

    // Constructing the box did not touch the native module; the first run does.
    const error = await box.run('() => 1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MissingPeerDependencyError);
    expect(error).toMatchObject({ packageName: 'isolated-vm', installCommand: 'npm install isolated-vm' });
    expect((error as Error).message).toContain('isolate');
    expect((error as Error).message).toContain('or pass another SandboxDriver');
  });
});

describe('sandboxDriverName', () => {
  it('reports the configured or defaulted driver', () => {
    expect(sandboxDriverName(undefined)).toBe('isolate');
    expect(sandboxDriverName('isolate')).toBe('isolate');
    expect(sandboxDriverName({ run: async () => 1 })).toBe('custom');
    expect(sandboxDriverName({ name: 'sidecar', run: async () => 1 })).toBe('sidecar');
  });
});
