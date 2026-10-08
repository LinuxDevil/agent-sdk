/**
 * Cloudflare Worker runtime for generated workers (LOU-I3, LOU-K3).
 *
 * The worker.ts the cloudflare-worker adapter scaffolds imports
 * `@lousho/build-ai-agent/deploy-runtime-worker`, resolved at build time to
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
 *    via resolveProvider(). Registered providers: 'mock', 'openai',
 *    'anthropic' (LOU-K3) and 'openrouter' (M3a). All three real providers
 *    are implemented on top of the Vercel `ai` SDK's
 *    `generateText`/`streamText` plus `@ai-sdk/openai`/`@ai-sdk/anthropic`
 *    (OpenRouter is `@ai-sdk/openai` pointed at openrouter.ai): pure
 *    fetch()/Web-standard implementations with no `node:*` imports, which the
 *    adapter's build verifies on every bundle. 'ollama' is NOT registered
 *    here: ollama-ai-provider defaults to a local http://localhost:11434
 *    endpoint unreachable from a Worker, so it remains node-server/docker-only.
 *  - Only the built-in tools that need no Node builtins are available:
 *    'current-date', 'day-name' and 'http' (M3a). The Node 'http' tool and
 *    'web-fetch' refuse private destinations through an undici Agent whose
 *    connect.lookup is the pinned lookup of src/security/privateAddress.ts
 *    (node:dns): it checks every address a host resolves to and the socket
 *    connects to the address it checked (N13a). Workers' fetch() resolves
 *    names inside Cloudflare's network with no hook to see or pin the
 *    address, so the Worker 'http' is a different tool under the same name
 *    and input (src/tools/built-in/workerHttp.ts): it checks only the URL,
 *    refuses IP-literal hosts and reaches only the host names listed in the
 *    `LOUSHO_HTTP_ALLOW` binding (none when unset: fail closed). It cannot
 *    guarantee where a listed name connects; the deployer vouches for the
 *    names they list. 'web-fetch' stays unsupported here.
 *  - LOU-T2, LOU-D51: sessions, durable execution (CheckpointStore-backed
 *    pause/resume, see src/execution/checkpoint.ts) and paused approvals live
 *    in a Workers KV namespace bound as `AGENT_CHECKPOINTS` (./checkpointBinding)
 *    - the same "declare a binding, read it off `env`" pattern `providerEnvKey()`
 *    uses for provider API keys. See `workerStore()` below.
 *  - LOU-D51: the Worker serves the node server's `/chat` API (sessions, SSE,
 *    approvals, bearer auth from the `LOUSHO_API_TOKEN` binding) through the
 *    Fetch-native src/server/fetchRoutes.ts. It runs the spec as a
 *    `createAgent()` agent, whose node-only imports (project instructions,
 *    file session store, MCP stdio) the adapter's build swaps for shims, see
 *    ./shims/node.worker.ts.
 *  - M3b: an agent directory is served by handleWorkerAgentDirRequest() from
 *    the WorkerAgentDir the build generated (./workerAgentDir.ts): its tools
 *    and an agent.ts config are bundled modules, the rest is embedded data.
 */
import { MockLLMProvider, MockProviderConfig } from '../providers/mock';
import { OpenAIProvider, OpenAIProviderConfig } from '../providers/OpenAIProvider';
import { AnthropicProvider, AnthropicProviderConfig } from '../providers/AnthropicProvider';
import { OpenRouterProvider, OpenRouterProviderConfig } from '../providers/OpenRouterProvider';
import { LLMProvider, LLMProviderRegistry } from '../providers/llm';
import { currentDateTool } from '../tools/built-in/currentDate';
import { dayNameTool } from '../tools/built-in/dayName';
import { createWorkerHttpTool, HTTP_ALLOW_BINDING, parseHostAllowList } from '../tools/built-in/workerHttp';
import { ToolDescriptor } from '../types';
import { AgentSpec } from '../spec/schema';
import { z } from 'zod';
import { createAgent, SimpleAgent } from '../createAgent';
import { memoryStore, AgentStore } from '../storage/agentStore';
import { serveFetch, type ChatRoutesContext } from '../server/fetchRoutes';
import { mountFetchChannels } from '../channels/fetchChannels';
import { continueChannelSignIn } from '../channels/channelCore';
import type { OAuthCompleteResult } from '../oauth/signIn';
import { defineTool, type DefinedTool } from '../tools/defineTool';
import type { MemorySlot } from '../memory/defineMemory';
import { bindWorkerMemoryProvider } from './workerMemory';
import {
  handleScheduled,
  logScheduleFailure,
  type ScheduledContext,
  type ScheduledController,
} from '../schedules/scheduled';
import { specSchedules } from '../schedules/specSchedules';
import { CHECKPOINT_KV_BINDING } from './checkpointBinding';
import { isKVBinding } from './kvCheckpointStore';
import { KVStore } from './kvStore';
import { prepareSpecExecution, PreparedExecution, SpecResolvers } from './specExecution';
import { SDKError } from '../execution/errors';
import {
  resolveWorkerAgentDir,
  type ResolvedWorkerAgentDir,
  type ResolvedWorkerSubagent,
  type WorkerAgentDir,
} from './workerAgentDir';

export { agentSpecSchema } from '../spec/schema';
export type { WorkerAgentDir } from './workerAgentDir';

// Registered directly here (rather than relying on lazy registration, LOU-R1)
// so the providers Workers actually support show up in has()/getProviderNames()
// from module load - see the module doc comment above. Anything not listed
// here ('ollama') still resolves on a create() miss via ensureBuiltinProviders(),
// but the adapter rejects it before a spec ever reaches a Worker.
LLMProviderRegistry.register('mock', (config) => new MockLLMProvider(config as MockProviderConfig));
LLMProviderRegistry.register('openai', (config) => new OpenAIProvider(config as OpenAIProviderConfig));
LLMProviderRegistry.register('anthropic', (config) => new AnthropicProvider(config as AnthropicProviderConfig));
LLMProviderRegistry.register('openrouter', (config) => new OpenRouterProvider(config as OpenRouterProviderConfig));

/** The Worker's built-in tools by spec name, built per request from the Worker's `env`. */
const WORKER_TOOLS: Record<string, (env: WorkerEnv) => ToolDescriptor> = {
  'current-date': () => currentDateTool,
  'day-name': () => dayNameTool,
  // M3a: only the hosts listed in the LOUSHO_HTTP_ALLOW binding; none when it is unset.
  http: (env) => createWorkerHttpTool({ allow: parseHostAllowList(env[HTTP_ALLOW_BINDING]) }),
};

/** Env binding each provider type reads its API key from, e.g. OPENAI_API_KEY. */
function providerEnvKey(type: string): string {
  return `${type.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
}

export type WorkerEnv = Record<string, unknown>;

/** Env binding holding the bearer token of the API (`wrangler secret put LOUSHO_API_TOKEN`). */
const API_TOKEN_BINDING = 'LOUSHO_API_TOKEN';

let isolateStore: Required<AgentStore> | undefined;

/**
 * The store of the Worker's agent: sessions, checkpoints, approvals and
 * OAuth tokens (encrypted with the `LOUSHO_TOKEN_KEY` secret) in the
 * KV namespace bound as `env[bindingName]`, or, when it isn't declared/bound,
 * in memory of this isolate (state is then lost whenever the isolate is - fine
 * for trying a deploy out, not for production). A bound value that doesn't look
 * like a KV namespace (missing get/put/delete) counts as not bound: `env` is
 * arbitrary platform-supplied input, and failing open beats failing every
 * request over a misconfigured binding.
 */
export function workerStore(env: WorkerEnv, bindingName: string = CHECKPOINT_KV_BINDING): Required<AgentStore> {
  const binding = env[bindingName];
  const tokenKey = env.LOUSHO_TOKEN_KEY; // a Worker secret: Workers have no process.env
  return isKVBinding(binding)
    ? new KVStore(binding, typeof tokenKey === 'string' && tokenKey !== '' ? { tokenKey: tokenKey.split(',') } : {})
    : (isolateStore ??= memoryStore());
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
        throw new SDKError(
          `tool '${name}' is not available on Cloudflare Workers. Available: ${Object.keys(WORKER_TOOLS).join(', ')}`,
          'LOUSHO_TOOL_NOT_FOUND'
        );
      }
      return tool(env);
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

/** Serves one request with `makeAgent`'s agent: the routes and bearer auth of {@link handleWorkerRequest}. */
function serveWorker(request: Request, env: WorkerEnv, makeAgent: () => SimpleAgent): Promise<Response> {
  const token = env[API_TOKEN_BINDING];
  // One agent per request: an approval route needs the agent that opened the session.
  let agent: SimpleAgent | undefined;
  const chat = { name: 'lousho worker', agent: () => (agent ??= makeAgent()), durableMessage: true };
  return serveFetch(request, chat, typeof token === 'string' && token ? token : undefined);
}

/**
 * Serves one request of the Worker's API: `GET /health` (open), sessions, SSE
 * streaming and approvals under `/chat`, and the deprecated `POST /chat
 * { message, sessionId? }`. With a `LOUSHO_API_TOKEN` binding every route but
 * `/health` needs `Authorization: Bearer <token>`.
 */
export function handleWorkerRequest(request: Request, env: WorkerEnv, spec: AgentSpec): Promise<Response> {
  return serveWorker(request, env, () => workerAgent(spec, env));
}

const resolvedDirs = new WeakMap<WorkerAgentDir, ResolvedWorkerAgentDir>();

/**
 * Validates an agent directory bundled by `lousho build --target=cloudflare-worker`
 * (M3b) and returns its `createAgent()` options; cached per directory. The
 * generated worker.ts calls it at module load, so a bad config or tool file
 * fails the Worker's startup instead of its first request.
 */
export function prepareWorkerAgentDir(dir: WorkerAgentDir): ResolvedWorkerAgentDir {
  let resolved = resolvedDirs.get(dir);
  if (!resolved) {
    resolved = resolveWorkerAgentDir(dir);
    resolvedDirs.set(dir, resolved);
  }
  return resolved;
}

/**
 * The `delegate_to_<name>` tool a parent agent calls to hand a task to the
 * sub-agent `sub` resolves to (the delegate tool `resolveAgentDir()` wires
 * `subagents/` up with, rebuilt here because that module needs `node:path`).
 */
function workerDelegateTool(sub: ResolvedWorkerSubagent, env: WorkerEnv): DefinedTool {
  const agent = workerAgentFromResolved(sub.dir, env);
  return defineTool({
    name: `delegate_to_${sub.name}`,
    description: `Delegate a task to the '${sub.name}' agent. ${sub.description}`,
    input: z.object({ task: z.string().describe('The complete task for the agent, with all needed context') }),
    execute: async ({ task }, ctx) => (await agent.send(task, { signal: ctx.abortSignal })).text,
  });
}

/** The memory slots with `kvMemory()` providers bound to `env`'s KV namespace (unbound: an in-memory provider). */
function boundMemory(slots: readonly MemorySlot[], env: WorkerEnv): MemorySlot[] {
  return slots.map((slot) => ({ ...slot, provider: bindWorkerMemoryProvider(slot.provider, env) }));
}

/** The `createAgent()` agent `resolved` describes, over the Worker's store and `env` bindings (sub-agents included). */
function workerAgentFromResolved(resolved: ResolvedWorkerAgentDir, env: WorkerEnv): SimpleAgent {
  const { name, instructions, model, tools, skills, maxSteps, toolConcurrency, memory, subagents, permissionMode, permissions, compaction, limits, approvalTtlMs, hooks, approve } = resolved;
  const source =
    'provider' in model
      ? model
      : { provider: workerResolvers(env).resolveProvider(model.providerType, model.model) };
  const allTools = [...tools, ...subagents.map((sub) => workerDelegateTool(sub, env))];
  return createAgent({
    name,
    instructions,
    ...source,
    ...(allTools.length > 0 ? { tools: allTools } : {}),
    ...(skills.length > 0 ? { skills } : {}),
    ...(memory.length > 0 ? { memory: boundMemory(memory, env) } : {}),
    ...(maxSteps === undefined ? {} : { maxSteps }),
    ...(toolConcurrency === undefined ? {} : { toolConcurrency }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(permissions === undefined ? {} : { permissions }),
    ...(compaction === undefined ? {} : { compaction }),
    ...(limits === undefined ? {} : { limits }),
    ...(approvalTtlMs === undefined ? {} : { approvalTtlMs }),
    ...(hooks === undefined ? {} : { hooks }),
    ...(approve === undefined ? {} : { approve }),
    store: workerStore(env),
  });
}

/**
 * The agent of a bundled agent directory over the Worker's store: its tools,
 * skills, memory slots and settings, a `delegate_to_<name>` tool per
 * `subagents/` entry (sub-agents inherit the parent's model unless they set
 * their own, as `resolveAgentDir()` does), and a `provider/model` config
 * resolved with the API key binding of that provider (e.g. `OPENAI_API_KEY`).
 */
export function workerAgentFromDir(dir: WorkerAgentDir, env: WorkerEnv): SimpleAgent {
  return workerAgentFromResolved(prepareWorkerAgentDir(dir), env);
}

/**
 * {@link handleWorkerRequest} for an agent directory (M3b): same routes and
 * bearer auth, the directory's agent - plus its `channels/` mounted under
 * `/channels` (they authenticate themselves, like the node server). `ctx` is
 * the Worker's ExecutionContext: a channel turn that outlives its
 * acknowledged request runs under `ctx.waitUntil`.
 */
export async function handleWorkerAgentDirRequest(
  request: Request,
  env: WorkerEnv,
  dir: WorkerAgentDir,
  ctx?: { waitUntil(promise: Promise<unknown>): void }
): Promise<Response> {
  const resolved = prepareWorkerAgentDir(dir);
  let agent: SimpleAgent | undefined;
  const makeAgent = () => (agent ??= workerAgentFromDir(dir, env));
  const channels =
    resolved.channels.length === 0 ? undefined : mountFetchChannels(makeAgent(), resolved.channels, { store: workerStore(env) });
  const token = env[API_TOKEN_BINDING];
  const chat: ChatRoutesContext = {
    name: 'lousho worker',
    agent: makeAgent,
    durableMessage: true,
    // B4: a turn whose client went away finishes (and is saved) inside `ctx.waitUntil`.
    ...(ctx && { waitUntil: (promise: Promise<unknown>) => ctx.waitUntil(promise) }),
    // N9b: a channel turn paused on a sign-in continues on its surface once the callback stored the token.
    ...(channels === undefined ? {} : { afterSignIn: (result: OAuthCompleteResult) => continueChannelSignIn(channels, result) }),
  };
  return (await channels?.(request, ctx)) ?? serveFetch(request, chat, typeof token === 'string' && token ? token : undefined);
}

export { handleScheduled } from '../schedules/scheduled';
export type { ScheduledContext, ScheduledController } from '../schedules/scheduled';

/**
 * The Worker's `scheduled()` handler: runs the spec's `{ type: 'cron' }`
 * triggers whose expression is `controller.cron` as agent turns (session
 * `schedule-<name>`, in the KV store when bound) inside `ctx.waitUntil`. Never
 * throws: a failure is logged with `console.error` and the schedule name.
 */
export function handleWorkerScheduled(
  controller: ScheduledController,
  env: WorkerEnv,
  ctx: ScheduledContext,
  spec: AgentSpec
): Promise<void> {
  try {
    const schedules = specSchedules(spec.triggers);
    return schedules.length === 0 ? Promise.resolve() : handleScheduled(workerAgent(spec, env), schedules, controller, ctx);
  } catch (error) {
    logScheduleFailure(controller.cron, error);
    return Promise.resolve();
  }
}

/**
 * {@link handleWorkerScheduled} for an agent directory's `schedules/` (#298):
 * the schedules whose `cron` equals `controller.cron` run as agent turns
 * (session `schedule-<name>`) inside `ctx.waitUntil`. Never throws.
 */
export function handleWorkerAgentDirScheduled(
  controller: ScheduledController,
  env: WorkerEnv,
  ctx: ScheduledContext,
  dir: WorkerAgentDir
): Promise<void> {
  try {
    const schedules = prepareWorkerAgentDir(dir).schedules;
    return schedules.length === 0 ? Promise.resolve() : handleScheduled(workerAgentFromDir(dir, env), schedules, controller, ctx);
  } catch (error) {
    logScheduleFailure(controller.cron, error);
    return Promise.resolve();
  }
}
