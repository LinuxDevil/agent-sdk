/**
 * The model-boundary interception seam (LOU-D46.2).
 *
 * Every model call an agent run makes - `generate()` or `stream()`, from a
 * top-level run, a streamed run, a sub-agent or an approval resume - goes
 * through one step of the run loop, which asks this registry for the provider
 * to call. With no interceptor installed that is the run's own provider, so
 * the seam costs nothing. `lousho eval --record / --replay` installs one that
 * answers with a per-case record/replay wrapper (see `src/evals/cassettes.ts`).
 *
 * An interceptor receives the run's provider and returns the provider to call
 * instead (or the same one). It must return a stable wrapper for a given
 * provider within the scope it serves, and return a provider it already
 * wrapped unchanged. This module imports nothing from `node:*`: an interceptor
 * that needs per-run state (AsyncLocalStorage) brings it itself.
 */
import type { LLMProvider } from './llm';

/** Returns the provider a model call should go to. */
export type ProviderInterceptor = (provider: LLMProvider) => LLMProvider;

// On globalThis so every bundle of the SDK (the CJS and ESM builds, a vitest worker) shares one slot.
const SLOT = Symbol.for('lousho.providerInterceptor');
const slot = globalThis as { [SLOT]?: ProviderInterceptor };

/**
 * Installs (or, with `undefined`, removes) the process-wide interceptor.
 * Returns the one it replaced so a caller can restore it.
 */
export function setProviderInterceptor(next: ProviderInterceptor | undefined): ProviderInterceptor | undefined {
  const previous = slot[SLOT];
  slot[SLOT] = next;
  return previous;
}

/** The provider a model call should use: `provider`, or what the installed interceptor makes of it. */
export function interceptProvider(provider: LLMProvider): LLMProvider {
  const interceptor = slot[SLOT];
  return interceptor ? interceptor(provider) : provider;
}
