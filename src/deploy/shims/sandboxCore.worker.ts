/**
 * Worker-safe stand-in for src/security/sandboxCore.ts (LOU-I3).
 *
 * The cloudflare-worker adapter's build redirects every SDK-internal import
 * of security/sandboxCore to this file. The real NoopSandbox runs commands
 * on the host via node:child_process, which does not exist on Workers; a
 * Worker has no host to run commands on at all, so here every sandbox call
 * fails loudly instead. Only tools that opt in via
 * `ToolDescriptor.requiresSandbox` ever reach the sandbox, and none of the
 * Worker-available built-in tools do.
 */
import type { SandboxAdapter, SandboxResult } from '../../security/sandboxCore';

export type { SandboxAdapter, SandboxResult, SandboxRunOptions } from '../../security/sandboxCore';

function unsupported(): never {
  throw new Error('Sandboxed tool execution is not supported on Cloudflare Workers (no host process to run commands in)');
}

export const NoopSandbox: SandboxAdapter = {
  name: 'noop',
  async run(): Promise<SandboxResult> {
    return unsupported();
  },
  async writeFile(): Promise<void> {
    unsupported();
  },
};
