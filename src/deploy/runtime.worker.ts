/**
 * Cloudflare Worker runtime for generated workers (LOU-I3, LOU-K3).
 *
 * The worker.ts the cloudflare-worker adapter scaffolds imports
 * `@loushy/build-ai-agent/deploy-runtime-worker`, resolved at build time to
 * this file. Everything reachable from here must run without Node builtins
 * (Workers have no node:fs/node:http/...): the adapter bundles with
 * platform 'browser' and swaps the one Node-dependent module on
 * AgentExecutor's import graph (security/sandboxCore's host-exec
 * NoopSandbox) for a Worker-safe shim - see
 * src/deploy/shims/sandboxCore.worker.ts.
 *
 * Differences from the Node runtime (./runtime.ts), all because of that
 * no-Node constraint:
 *  - Providers are created via LLMProviderRegistry with the API key read
 *    from the Worker's `env` bindings (Workers have no process.env), not
 *    via resolveProvider(). Registered providers: 'mock', 'openai' and
 *    'anthropic' (LOU-K3). Both real providers are implemented on top of
 *    the Vercel `ai` SDK's `generateText`/`streamText` plus
 *    `@ai-sdk/openai`/`@ai-sdk/anthropic` - verified (see LOU-K3 PR
 *    description) to be pure fetch()/Web-standard implementations with no
 *    `node:*` imports anywhere in their dependency graphs, so they bundle
 *    and run on Workers cleanly. 'ollama' and 'openrouter' are NOT
 *    registered here: ollama-ai-provider defaults to a local
 *    http://localhost:11434 endpoint unreachable from a Worker and isn't
 *    a realistic Workers target, and openrouter has had no Workers
 *    compatibility audit - both remain node-server/docker-only for now.
 *  - Only the built-in tools that need no Node builtins are available
 *    ('current-date', 'day-name'); 'http' uses node:net/node:dns/undici
 *    for its SSRF denylist (DNS-rebinding-safe resolve-then-verify) and a
 *    pinned undici Agent/dispatcher for per-request TLS settings - neither
 *    has a Workers-native equivalent (fetch() gives no hook to resolve a
 *    hostname up front and pin the connection to the verified IP), so a
 *    Workers 'http' tool re-implemented on plain fetch() would silently
 *    drop that DNS-rebinding protection rather than just losing convenience
 *    functionality. Left unsupported here rather than shipping a weaker
 *    tool under the same name - see LOU-K3 PR description.
 */
import '../providers/mock';
import { OpenAIProvider, OpenAIProviderConfig } from '../providers/OpenAIProvider';
import { AnthropicProvider, AnthropicProviderConfig } from '../providers/AnthropicProvider';
import { LLMProvider, LLMProviderRegistry } from '../providers/llm';
import { currentDateTool } from '../tools/built-in/currentDate';
import { dayNameTool } from '../tools/built-in/dayName';
import { ToolDescriptor } from '../types';
import { AgentSpec } from '../spec/schema';
import { prepareSpecExecution, PreparedExecution } from './specExecution';

export { AgentExecutor } from '../execution/AgentExecutor';
export { agentSpecSchema } from '../spec/schema';

// Registered directly here (rather than via the '../providers' barrel,
// which also eagerly imports OllamaProvider/OpenRouterProvider and their
// optional peer SDKs) so the Worker bundle only pulls in the two providers
// actually supported on Workers - see the module doc comment above.
LLMProviderRegistry.register('openai', (config) => new OpenAIProvider(config as OpenAIProviderConfig));
LLMProviderRegistry.register('anthropic', (config) => new AnthropicProvider(config as AnthropicProviderConfig));

const WORKER_TOOLS: Record<string, ToolDescriptor> = {
  'current-date': currentDateTool,
  'day-name': dayNameTool,
};

/** Env binding each provider type reads its API key from, e.g. OPENAI_API_KEY. */
export function providerEnvKey(type: string): string {
  return `${type.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
}

export type WorkerEnv = Record<string, unknown>;

export function prepareWorkerSpec(spec: AgentSpec, env: WorkerEnv = {}): PreparedExecution {
  return prepareSpecExecution(spec, {
    resolveProvider: (type: string, model: string): LLMProvider => {
      const apiKey = env[providerEnvKey(type)];
      return LLMProviderRegistry.create(type, {
        defaultModel: model,
        apiKey: typeof apiKey === 'string' ? apiKey : undefined,
      });
    },
    resolveTool: (name: string): ToolDescriptor => {
      const tool = WORKER_TOOLS[name];
      if (!tool) {
        throw new Error(
          `tool '${name}' is not available on Cloudflare Workers. Available: ${Object.keys(WORKER_TOOLS).join(', ')}`
        );
      }
      return tool;
    },
  });
}
