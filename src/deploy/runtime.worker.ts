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
 *  - LOU-T2, LOU-D51: sessions, durable execution (CheckpointStore-backed
 *    pause/resume, see src/execution/checkpoint.ts) and paused approvals live
 *    in a Workers KV namespace bound as `AGENT_CHECKPOINTS` (./checkpointBinding)
 *    - the same "declare a binding, read it off `env`" pattern `providerEnvKey()`
 *    uses for provider API keys. See `workerStore()` below.
 *  - LOU-D51: the Worker serves the node server's `/chat` API (sessions, SSE,
 *    approvals, bearer auth from the `LOUSHY_API_TOKEN` binding) through the
 *    Fetch-native src/server/fetchRoutes.ts. It runs the spec as a
 *    `createAgent()` agent, whose node-only imports (project instructions,
 *    file session store, MCP stdio) the adapter's build swaps for shims, see
 *    ./shims/node.worker.ts.
 */
import '../providers/mock';
import { OpenAIProvider, OpenAIProviderConfig } from '../providers/OpenAIProvider';
import { AnthropicProvider, AnthropicProviderConfig } from '../providers/AnthropicProvider';
import { LLMProvider, LLMProviderRegistry } from '../providers/llm';
import { currentDateTool } from '../tools/built-in/currentDate';
import { dayNameTool } from '../tools/built-in/dayName';
import { ToolDescriptor } from '../types';
import { AgentSpec } from '../spec/schema';
import { createAgent, SimpleAgent } from '../createAgent';
import { memoryStore, AgentStore } from '../storage/agentStore';
import { serveFetch } from '../server/fetchRoutes';
import { CHECKPOINT_KV_BINDING } from './checkpointBinding';
import { KVBinding } from './kvCheckpointStore';
import { KVStore } from './kvStore';
import { prepareSpecExecution, PreparedExecution, SpecResolvers } from './specExecution';

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
function providerEnvKey(type: string): string {
  return `${type.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
}

export type WorkerEnv = Record<string, unknown>;

/** Env binding holding the bearer token of the API (`wrangler secret put LOUSHY_API_TOKEN`). */
const API_TOKEN_BINDING = 'LOUSHY_API_TOKEN';

const KV_METHODS = ['get', 'put', 'delete'] as const;

/** True when `value` has the get/put/delete functions of a KV namespace. */
function isKVBinding(value: unknown): value is KVBinding {
  const binding = value as Partial<KVBinding> | undefined;
  return !!binding && KV_METHODS.every((method) => typeof binding[method] === 'function');
}

let isolateStore: Required<AgentStore> | undefined;

/**
 * The store of the Worker's agent: sessions, checkpoints and approvals in the
 * KV namespace bound as `env[bindingName]`, or, when it isn't declared/bound,
 * in memory of this isolate (state is then lost whenever the isolate is - fine
 * for trying a deploy out, not for production). A bound value that doesn't look
 * like a KV namespace (missing get/put/delete) counts as not bound: `env` is
 * arbitrary platform-supplied input, and failing open beats failing every
 * request over a misconfigured binding.
 */
export function workerStore(env: WorkerEnv, bindingName: string = CHECKPOINT_KV_BINDING): AgentStore {
  const binding = env[bindingName];
  return isKVBinding(binding) ? new KVStore(binding) : (isolateStore ??= memoryStore());
}

function workerResolvers(env: WorkerEnv): SpecResolvers {
  return {
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
  };
}

export function prepareWorkerSpec(spec: AgentSpec, env: WorkerEnv = {}): PreparedExecution {
  return prepareSpecExecution(spec, workerResolvers(env));
}

/** The spec's agent over the Worker's store (see {@link workerStore}). */
function workerAgent(spec: AgentSpec, env: WorkerEnv): SimpleAgent {
  const { resolveProvider, resolveTool } = workerResolvers(env);
  const tools = Object.fromEntries((spec.tools ?? []).map((name) => [name, resolveTool(name)]));
  return createAgent({
    name: spec.name,
    prompt: spec.prompt,
    provider: resolveProvider(spec.provider.type, spec.provider.model),
    tools: Object.keys(tools).length > 0 ? tools : undefined,
    store: workerStore(env),
  });
}

/**
 * Serves one request of the Worker's API: `GET /health` (open), sessions, SSE
 * streaming and approvals under `/chat`, and the deprecated `POST /chat
 * { message, sessionId? }`. With a `LOUSHY_API_TOKEN` binding every route but
 * `/health` needs `Authorization: Bearer <token>`.
 */
export function handleWorkerRequest(request: Request, env: WorkerEnv, spec: AgentSpec): Promise<Response> {
  const token = env[API_TOKEN_BINDING];
  // One agent per request: an approval route needs the agent that opened the session.
  let agent: SimpleAgent | undefined;
  const chat = { name: 'loushy worker', agent: () => (agent ??= workerAgent(spec, env)), durableMessage: true };
  return serveFetch(request, chat, typeof token === 'string' && token ? token : undefined);
}
