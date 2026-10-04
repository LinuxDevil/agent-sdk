/**
 * The Worker-safe entry point `@lousho/build-ai-agent/worker` (#289): what a
 * hand-written Cloudflare Worker imports `createAgent` and friends from.
 *
 * The package root (`src/index.ts`) also exports file stores, the
 * agent-directory loader, MCP over stdio, sandboxes and other Node-only
 * modules, so `import { createAgent } from '@lousho/build-ai-agent'` cannot
 * be bundled for a Worker: esbuild fails resolving `node:fs`, `node:crypto`
 * & co. This entry exports `createAgent` and the rest of what a Worker can
 * run, and the SDK's own build produces it through workerEntryPlugins()
 * (./bundle.ts) - the same shims `lousho build --target=cloudflare-worker`
 * applies - so the published `dist/deploy/worker.*` has no `node:` import
 * left for a user's bundler to trip on. src/deploy/worker.test.ts guards
 * the graph.
 *
 * The provider packages stay lazy: `ai`, `zod` and `@opentelemetry/api`
 * come from the user's install (the SDK's peers), and `@ai-sdk/openai` /
 * `@ai-sdk/anthropic` are loaded on first generate()/stream() - install the
 * one your provider needs (`mock` needs none; it still has to resolve, so a
 * bundler without it should mark it `external`). Features a Worker cannot
 * run (project instructions, the file session store, guardrail patches,
 * sandboxed tools, code mode, the ollama provider) or that need a bundled
 * optional peer a hand-written Worker cannot expect installed (`mcpServers`,
 * over stdio or streamable HTTP - use `lousho build` for that) are the
 * shimmed versions, which fail when called. Type-only imports are erased
 * and work for every type.
 */
export * from './workerSdk';

export { createAgent, createAgentConfigOf } from '../createAgent';
export type {
  CreateAgentBase,
  CreateAgentConfig,
  CreateAgentInstructions,
  CreateAgentModelSource,
  PerRun,
  RunConfigContext,
  SendOptions,
  SimpleAgent,
} from '../createAgent';

export { memoryStore } from '../storage/agentStore';
export type { AgentStore, MemoryStoreOptions } from '../storage/agentStore';

// The KV-backed AgentStore for a hand-written Worker (also on `/kv`).
export { KVStore } from './kvStore';
export type { KVStoreOptions } from './kvStore';
export { KVCheckpointStore } from './kvCheckpointStore';
export type { KVBinding, KVListOptions, KVListResult, KVPutOptions } from './kvCheckpointStore';
export { CHECKPOINT_KV_BINDING } from './checkpointBinding';

// Cron triggers, for the Worker's `scheduled()` handler.
export { defineSchedule, isDefinedSchedule } from '../schedules/defineSchedule';
export type { DefinedSchedule, PromptScheduleInput, RunScheduleInput, ScheduleContext, ScheduleInput } from '../schedules/defineSchedule';
export { handleScheduled } from '../schedules/scheduled';
export type { ScheduledContext, ScheduledController } from '../schedules/scheduled';

// The `/chat` HTTP API the generated Worker serves, as a fetch handler a
// hand-written Worker can mount (`serveFetch(request, chat, token?)`).
export { serveFetch } from '../server/fetchRoutes';
export type { ChatRoutesContext, ServeAuth } from '../server/fetchRoutes';

// Types a hand-written Worker commonly needs; erased at build time.
export type { AgentEvent } from '../execution/agentEvents';
export type { AgentInput } from '../providers/content';
export type { AgentSpec } from '../spec/schema';
export type { LLMProvider } from '../providers/llm';
export type { ToolDescriptor } from '../types';
