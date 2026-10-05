/**
 * Worker-safe stand-in for the optional peer `@earendil-works/pi-ai` (H2,
 * #289 pattern).
 *
 * `PiProvider` lazy-imports the package's `/compat` and `/providers/all`
 * entrypoints on first call. The `/worker` subpath entry is bundled by the
 * user's own build, where an unresolved specifier would fail with "Could
 * not resolve" (the package is optional and usually not installed), so the
 * entry's build redirects every `@earendil-works/pi-ai*` specifier here -
 * like the `ollama-ai-provider` and MCP shims. The calls then fail on first
 * use, a code path a Worker never reaches anyway: `pi` is Node-only and is
 * not in WORKER_SUPPORTED_PROVIDERS.
 */
import { SDKError } from '../../execution/errors';

function unavailable(): never {
  throw new SDKError(
    "provider 'pi' is not available on Cloudflare Workers: @earendil-works/pi-ai is a Node.js package. " +
      "Use the 'mock', 'openai', 'anthropic' or 'openrouter' providers, or the node-server/docker targets.",
    'LOUSHO_DEPLOY_FAILED'
  );
}

export const stream = unavailable;
export const complete = unavailable;
export const streamSimple = unavailable;
export const completeSimple = unavailable;
export const getEnvApiKey = unavailable;
export const registerFauxProvider = unavailable;
export const getBuiltinModel = unavailable;
export const getBuiltinModels = unavailable;
export const getBuiltinProviders = unavailable;
export const builtinModels = unavailable;
export default unavailable;
