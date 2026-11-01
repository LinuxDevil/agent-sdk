/**
 * SpecHost: what a spec cannot hold but its compiled agent needs — where
 * relative paths start, how named secrets resolve, where spans and sessions
 * go. specV2ToAgent() (./specToAgent.ts) takes one; it extends the
 * resolve/ hosts so every resolver sees the fields it already knows.
 * Browser-safe: type-only imports.
 */
import type { SimpleAgent } from '../../createAgent';
import type { TraceExporter } from '../../execution/tracing';
import type { AgentStore } from '../../storage/agentStore';
import type { HookHost } from './resolve/hooks';
import type { MemoryHost } from './resolve/memory';
import type { SecretHost } from './resolve/secrets';
import type { SkillHost } from './resolve/skills';
import type { ToolRefHost } from './resolve/tools';
import type { AgentSpecV2 } from './types';

/**
 * The host specV2ToAgent()/compileSpec() compile against: SecretHost for
 * `{ env }`/`{ secret }` refs, ToolRefHost's baseDir (required here),
 * MemoryHost's embedder builder, SkillHost's baseDir, HookHost's
 * `inlineHook` sandbox runner (absent → inline hooks are unsupported) and
 * the createAgent() options only a host can supply. `agentName` is taken
 * from the spec, not the host.
 */
export interface SpecHost extends SecretHost, Omit<ToolRefHost, 'agentName'>, MemoryHost, SkillHost, HookHost {
  /** Directory `instructions.file` and `{ file }`/`{ registry }`/`{ dir }` refs resolve against. Required here (ToolRefHost's is optional). */
  baseDir: string;
  /** Trace exporter the built agent runs with (createAgent's `exporter`). */
  exporter?: TraceExporter;
  /** Store the built agent keeps sessions, checkpoints and approvals in (createAgent's `store`). */
  store?: AgentStore;
  /** Loads a subagent `{ ref }` (S08's loadAgentRef). Absent → refs are unsupported on this host. */
  loadAgentRef?(ref: string): Promise<AgentSpecV2>;
  /** Target of a handoff that is not one of this spec's subagents (an agent id in Studio). */
  resolveHandoffAgent?(agent: string): Promise<SimpleAgent>;
}
