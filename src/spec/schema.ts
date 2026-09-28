/**
 * Declarative agent spec file format (LOU-H9).
 *
 * A plain-data description of an agent - name, prompt, provider, tool
 * names - that can be authored as YAML or JSON and turned into a live
 * agent via specToAgent(). The TS interface and the zod schema below are
 * kept in lockstep by hand (zod is already a project dependency; no
 * schema-to-type codegen is set up in this repo).
 */
import { z } from 'zod';

export interface AgentSpecProvider {
  type: string;
  model: string;
}

/**
 * Optional cross-harness execution policy (LOU-J1+). Deliberately loose -
 * different target harnesses (Claude Code, Codex, Pi, ...) each honor a
 * different subset of this, and new fields are expected to be added by
 * later generators without needing a schema migration every time, so this
 * is intentionally an open record (`.passthrough()` on the zod side) rather
 * than a closed, harness-specific shape.
 */
export interface AgentSpecPolicy {
  /** Whether tool calls from this agent require human approval before running (LOU-C). */
  requiresApproval?: boolean;
  /** Named guardrails (see src/execution/guardrails.ts) this agent's actions must pass. */
  guardrails?: string[];
  /** Additional, harness-specific policy fields. */
  [key: string]: unknown;
}

/**
 * Optional trigger describing when/how this agent is invoked outside of a
 * direct call (e.g. a monitoring webhook, a cron schedule). Open record for
 * the same reason as AgentSpecPolicy above.
 */
export interface AgentSpecTrigger {
  type: string;
  [key: string]: unknown;
}

export interface AgentSpec {
  name: string;
  prompt: string;
  provider: AgentSpecProvider;
  tools?: string[];
  /**
   * Optional (LOU-J1+, backward-compatible with LOU-H9's original
   * {name, prompt, provider, tools} shape - existing specs that omit this
   * still validate and load unchanged).
   */
  policy?: AgentSpecPolicy;
  /** Optional (LOU-J1+), same backward-compatibility note as `policy`. */
  triggers?: AgentSpecTrigger[];
}

export const agentSpecProviderSchema = z.object({
  type: z.string({
    required_error: "AgentSpec validation failed: missing required field 'provider.type'",
  }),
  model: z.string({
    required_error: "AgentSpec validation failed: missing required field 'provider.model'",
  }),
});

export const agentSpecPolicySchema = z
  .object({
    requiresApproval: z.boolean().optional(),
    guardrails: z.array(z.string()).optional(),
  })
  .passthrough();

export const agentSpecTriggerSchema = z
  .object({
    type: z.string({
      required_error: "AgentSpec validation failed: missing required field 'triggers[].type'",
    }),
  })
  .passthrough();

export const agentSpecSchema = z.object({
  name: z.string({
    required_error: "AgentSpec validation failed: missing required field 'name'",
  }),
  prompt: z.string({
    required_error: "AgentSpec validation failed: missing required field 'prompt'",
  }),
  provider: agentSpecProviderSchema,
  tools: z.array(z.string()).optional(),
  policy: agentSpecPolicySchema.optional(),
  triggers: z.array(agentSpecTriggerSchema).optional(),
});
