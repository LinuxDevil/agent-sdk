/**
 * SpecHost: what a spec cannot hold but its compiled agent needs — where
 * relative paths start, how named secrets resolve, where spans and sessions
 * go. specV2ToAgent() (./specToAgent.ts) takes one; it extends the
 * resolve/ hosts so every resolver sees the fields it already knows.
 * Browser-safe: type-only imports.
 */
import type { TraceExporter } from '../../execution/tracing';
import type { AgentStore } from '../../storage/agentStore';
import type { HookHost } from './resolve/hooks';
import type { SecretHost } from './resolve/secrets';
import type { ToolRefHost } from './resolve/tools';

/**
 * The host specV2ToAgent()/compileSpec() compile against: SecretHost for
 * `{ env }`/`{ secret }` refs, ToolRefHost's baseDir (required here),
 * HookHost's `inlineHook` sandbox runner (absent → inline hooks are
 * unsupported) and the createAgent() options only a host can supply.
 * `agentName` is taken from the spec, not the host.
 */
export interface SpecHost extends SecretHost, Omit<ToolRefHost, 'agentName'>, HookHost {
  /** Directory `instructions.file` and `{ file }`/`{ registry }` tool refs resolve against. Required here (ToolRefHost's is optional). */
  baseDir: string;
  /** Trace exporter the built agent runs with (createAgent's `exporter`). */
  exporter?: TraceExporter;
  /** Store the built agent keeps sessions, checkpoints and approvals in (createAgent's `store`). */
  store?: AgentStore;
}
