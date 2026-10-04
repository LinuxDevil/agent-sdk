/**
 * Worker-safe stand-in for the optional peers `ollama-ai-provider` and
 * `ollama-ai-provider-v2` (#289).
 *
 * `OllamaProvider` lazy-imports whichever of those packages the installed
 * `ai` major pairs with. The generated Worker (`lousho build
 * --target=cloudflare-worker`) leaves the specifier external behind a
 * `no_bundle` upload, but the `/worker` subpath entry is bundled by the
 * user's own build, where an unresolved specifier fails with "Could not
 * resolve" (the package is optional and usually not installed) - so the
 * entry's build redirects both specifiers here instead. `createOllama()`
 * then fails on first use, a code path a Worker could never reach anyway:
 * Ollama defaults to a local http://localhost:11434 endpoint (see
 * runtime.worker.ts / WORKER_SUPPORTED_PROVIDERS, which exclude it).
 */
import { SDKError } from '../../execution/errors';

export function createOllama(): never {
  throw new SDKError(
    "provider 'ollama' is not available on Cloudflare Workers: ollama-ai-provider targets a local Ollama endpoint a Worker cannot reach. Use the 'mock', 'openai', 'anthropic' or 'openrouter' providers, or the node-server/docker targets.",
    'LOUSHO_DEPLOY_FAILED'
  );
}
