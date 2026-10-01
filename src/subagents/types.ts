import type { SimpleAgent } from '../createAgent';

/** A sub-agent as listed to the lead agent: its name and what it is for. */
export interface SubagentSummary {
  /** The name the lead passes as the `task` tool's `agent`. */
  name: string;
  /** What the sub-agent does; shown to the lead model so it can pick one. */
  description: string;
}

/**
 * A dynamic set of sub-agents (LOU-Y3). `list()` is called at the start of
 * every run that offers the `task` tool; `resolve(name)` when the lead calls
 * `task` with that name (return `undefined` for an unknown name).
 *
 * @example
 * ```ts
 * const catalog: SubagentCatalog = {
 *   list: async () => [{ name: 'researcher', description: 'Finds and summarizes sources' }],
 *   resolve: async (name) => (name === 'researcher' ? researcher : undefined),
 * };
 * ```
 */
export interface SubagentCatalog {
  list(): readonly SubagentSummary[] | Promise<readonly SubagentSummary[]>;
  resolve(name: string): LocalOrRemoteSubagent | undefined | Promise<LocalOrRemoteSubagent | undefined>;
}

/** What a sub-agent can be: a `createAgent()` agent, or a deployed one from `remoteAgent()`. */
type LocalOrRemoteSubagent = SimpleAgent | RemoteSubagent;

/** Options of `remoteAgent()` (LOU-Y7). */
export interface RemoteAgentOptions {
  /** Base URL of the deployed agent; the task goes to `<url>/chat`. */
  url: string;
  /** Bearer token (`LOUSHY_API_TOKEN` of the deployment), or a function returning it, called per task. */
  auth?: string | (() => string | Promise<string>);
  /** Name used in errors and the footer; defaults to the key in `subagents`. */
  name?: string;
  /** What the remote agent is for, shown to the lead model. */
  description?: string;
  /** Extra request headers (`Authorization` from `auth` wins). */
  headers?: Record<string, string>;
  /** `fetch` to use; defaults to the global one. For tests and custom transports. */
  fetch?: typeof fetch;
}

/** A deployed agent usable as a sub-agent; made by `remoteAgent()`. */
export interface RemoteSubagent {
  readonly name?: string;
  readonly description: string;
  /** Runs one task in a fresh remote session and resolves with the remote agent's final text. */
  run(prompt: string, options?: { name?: string; signal?: AbortSignal }): Promise<string>;
}

/**
 * The sub-agents a lead agent can delegate to with the `task` tool: a record
 * of `createAgent()` agents keyed by name (each needs a `description`), or a
 * {@link SubagentCatalog}.
 */
export type Subagents = Readonly<Record<string, LocalOrRemoteSubagent>> | SubagentCatalog;
