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
 *  - LOU-T2: durable execution (CheckpointStore-backed pause/resume, see
 *    src/execution/checkpoint.ts) is opt-in here via a Workers KV namespace
 *    binding - see `CHECKPOINT_KV_BINDING`/`checkpointStoreFromEnv()` below,
 *    the same "declare a binding, read it off `env`" pattern
 *    `providerEnvKey()` already uses for provider API keys.
 */
import '../providers/mock';
import { OpenAIProvider, OpenAIProviderConfig } from '../providers/OpenAIProvider';
import { AnthropicProvider, AnthropicProviderConfig } from '../providers/AnthropicProvider';
import { LLMProvider, LLMProviderRegistry } from '../providers/llm';
import { currentDateTool } from '../tools/built-in/currentDate';
import { dayNameTool } from '../tools/built-in/dayName';
import { ToolDescriptor } from '../types';
import { AgentSpec } from '../spec/schema';
import { CheckpointStore } from '../execution/checkpoint';
import { KVBinding, KVCheckpointStore } from './kvCheckpointStore';
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

/**
 * LOU-T2: the `env` binding name a Worker deployment must declare (in
 * `wrangler.toml`, see `cloudflare.ts`'s scaffolded config) to opt in to
 * durable execution - a KV namespace bound under this name lets a paused
 * run's Checkpoint survive across requests/isolates, the same way a
 * filesystem- or StorageService-backed CheckpointStore does off-Worker (see
 * LocalStorageCheckpointStore in src/execution/checkpoint.ts and
 * apps/agent-forge/server/checkpointStore.ts's FileCheckpointStore).
 * Mirrors `providerEnvKey()` immediately below: a documented, fixed binding
 * name a consumer wires up themselves rather than something this SDK
 * provisions for them.
 */
export const CHECKPOINT_KV_BINDING = 'AGENT_CHECKPOINTS';

/**
 * Builds a `KVCheckpointStore` from the `env[CHECKPOINT_KV_BINDING]`
 * binding, or returns `undefined` when it isn't declared/bound - durable
 * execution on Workers is opt-in, not required, so a spec with no KV
 * binding configured still runs (just without pause/resume durability,
 * exactly like the pre-LOU-T2 behavior).
 *
 * A bound value that doesn't look like a KV namespace (missing
 * get/put/delete) is also treated as "not configured" rather than thrown on
 * - `env` is arbitrary platform-supplied input, not something this SDK
 * controls the shape of, and failing open here (no durable store, run still
 * works) is safer than failing every request over a misconfigured binding.
 */
export function checkpointStoreFromEnv(
  env: WorkerEnv,
  bindingName: string = CHECKPOINT_KV_BINDING
): CheckpointStore | undefined {
  const binding = env[bindingName] as Partial<KVBinding> | undefined;
  if (
    !binding ||
    typeof binding.get !== 'function' ||
    typeof binding.put !== 'function' ||
    typeof binding.delete !== 'function'
  ) {
    return undefined;
  }
  return new KVCheckpointStore(binding as KVBinding);
}

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
