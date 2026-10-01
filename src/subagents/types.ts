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
  resolve(name: string): SimpleAgent | undefined | Promise<SimpleAgent | undefined>;
}

/**
 * The sub-agents a lead agent can delegate to with the `task` tool: a record
 * of `createAgent()` agents keyed by name (each needs a `description`), or a
 * {@link SubagentCatalog}.
 */
export type Subagents = Readonly<Record<string, SimpleAgent>> | SubagentCatalog;
