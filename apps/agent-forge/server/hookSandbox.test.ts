import { describe, expect, it } from 'vitest';
import { NoopSandbox } from '@loushy/build-ai-agent';
import { sandboxRunHook } from './hookSandbox';

describe('sandboxRunHook (LOU-Q2)', () => {
  it('runs a hook body as a real subprocess via SandboxAdapter.run() and returns its mutated ctx', async () => {
    const result = await sandboxRunHook(NoopSandbox, 'ctx.args.email = "[REDACTED]"; return ctx;', {
      toolName: 'sendEmail',
      args: { email: 'real@example.com' },
    });

    expect(result).toEqual({ toolName: 'sendEmail', args: { email: '[REDACTED]' } });
  });

  it('supports async hook bodies (await inside the code)', async () => {
    const result = await sandboxRunHook(
      NoopSandbox,
      'await new Promise((r) => setTimeout(r, 1)); ctx.touched = true; return ctx;',
      { touched: false }
    );
    expect(result.touched).toBe(true);
  });

  it('falls back to the original ctx when the hook mutates in place but returns nothing', async () => {
    const result = await sandboxRunHook(NoopSandbox, 'ctx.args.x = 1;', { args: { x: 0 } });
    expect(result).toEqual({ args: { x: 1 } });
  });

  it('rejects when the hook code throws, carrying the error message', async () => {
    await expect(
      sandboxRunHook(NoopSandbox, 'throw new Error("boom from hook");', {})
    ).rejects.toThrow(/boom from hook/);
  });

  it('does not have access to this process\'s in-memory state (runs in a real child process)', async () => {
    (globalThis as Record<string, unknown>).__hookSandboxCanary = 'host-secret';
    const result = await sandboxRunHook(
      NoopSandbox,
      'ctx.sawCanary = typeof globalThis.__hookSandboxCanary; return ctx;',
      {}
    );
    expect(result.sawCanary).toBe('undefined');
    delete (globalThis as Record<string, unknown>).__hookSandboxCanary;
  });
});
