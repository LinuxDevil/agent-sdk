/**
 * Cloudflare Worker runtime for generated workers (LOU-I3).
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
 *    via resolveProvider(). Only 'mock' is registered in the bundle -
 *    the real provider classes depend on optional-peer SDK packages that
 *    this bundle does not include.
 *  - Only the built-in tools that need no Node builtins are available
 *    ('current-date', 'day-name'); 'http' uses node:net/node:dns/undici.
 */
import '../providers/mock';
import { LLMProvider, LLMProviderRegistry } from '../providers/llm';
import { currentDateTool } from '../tools/built-in/currentDate';
import { dayNameTool } from '../tools/built-in/dayName';
import { ToolDescriptor } from '../types';
import { AgentSpec } from '../spec/schema';
import { prepareSpecExecution, PreparedExecution } from './specExecution';

export { AgentExecutor } from '../execution/AgentExecutor';
export { agentSpecSchema } from '../spec/schema';

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
