/**
 * Built-in deployment adapters (LOU-I2+).
 *
 * Registration is an explicit registerBuiltInAdapters() call (made by the
 * `loushy build` CLI at startup) rather than a top-level side effect in
 * each adapter module: a side-effect-only registration is exactly what
 * bundlers tree-shake away (see the LOU-H 'mock' provider fix in
 * spec/specToAgent.ts), and dist/cli/build.js is a bundled entrypoint.
 */
import { registerAdapter } from './types';
import { NodeServerAdapter } from './adapters/node-server';
import { CloudflareWorkerAdapter } from './adapters/cloudflare';

export * from './types';
export { NodeServerAdapter, CloudflareWorkerAdapter };

/** Registers every built-in adapter under its target name. Idempotent. */
export function registerBuiltInAdapters(): void {
  registerAdapter('node-server', NodeServerAdapter);
  registerAdapter('cloudflare-worker', CloudflareWorkerAdapter);
}
