/**
 * Lazy Node builtins for the observe modules that also ship in the Worker
 * bundle (identity.ts, blockingPost.ts): `undefined` on runtimes without
 * them, never an import for the bundler to resolve.
 *
 * Named to match the worker leak check's exempted call pattern (see
 * WORKER_SAFE_BUILTIN_PROBE in src/deploy/adapters/cloudflare.ts): a builtin
 * id literal stays out of the flagged set only while it appears as this
 * function's argument at the call site. Do not rename.
 */
export function getBuiltinModule<T>(name: string): T | undefined {
  if (typeof process === 'undefined') return undefined;
  return (process.getBuiltinModule?.(name) as T | undefined) ?? undefined;
}
