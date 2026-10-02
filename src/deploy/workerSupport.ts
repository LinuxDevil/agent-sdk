/**
 * What the cloudflare-worker target supports. Node-free: read by the adapter
 * (src/deploy/adapters/cloudflare.ts) at build time and by the Worker runtime
 * (src/deploy/workerAgentDir.ts) inside the bundle.
 */

/**
 * Built-in tools that work without Node builtins (see runtime.worker.ts).
 * 'http' (M3a) is the Worker's own http_request: listed host names only, from
 * the LOUSHO_HTTP_ALLOW binding (src/tools/built-in/workerHttp.ts).
 */
export const WORKER_SUPPORTED_TOOLS = ['current-date', 'day-name', 'http'];
/**
 * Provider types registered in the Worker bundle (see runtime.worker.ts).
 *
 * 'openai', 'anthropic' (LOU-K3) and 'openrouter' (M3a) are real,
 * network-calling providers - implemented on the Vercel `ai` SDK's
 * fetch()-based generateText/streamText plus @ai-sdk/openai /
 * @ai-sdk/anthropic, which have no `node:*` imports in their dependency
 * graph (the build's leak check verifies every bundle). 'ollama' remains
 * unsupported here (see runtime.worker.ts's doc comment for why).
 */
export const WORKER_SUPPORTED_PROVIDERS = ['mock', 'openai', 'anthropic', 'openrouter'];
