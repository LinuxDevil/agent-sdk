/**
 * Worker-safe stand-in for the optional peer `@ai-sdk/google`.
 *
 * `GoogleProvider` lazy-imports `@ai-sdk/google`. The `/worker` subpath
 * entry is bundled by the user's own build, where that specifier would fail
 * with "Could not resolve" (the package is optional and usually not
 * installed), so the entry's build redirects it here instead, the way it
 * redirects the Ollama packages. 'google' is not one of the
 * WORKER_SUPPORTED_PROVIDERS, so `createGoogleGenerativeAI()` fails on first use.
 */
import { SDKError } from '../../execution/errors';

export function createGoogleGenerativeAI(): never {
  throw new SDKError(
    "provider 'google' is not available on Cloudflare Workers yet. Use the 'mock', 'openai', 'anthropic' or 'openrouter' providers " +
      "(Gemini through OpenRouter: 'openrouter/google/<model>'), or the node-server/docker targets.",
    'LOUSHO_DEPLOY_FAILED'
  );
}
