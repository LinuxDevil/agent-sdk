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

export interface AgentSpec {
  name: string;
  prompt: string;
  provider: AgentSpecProvider;
  tools?: string[];
}

export const agentSpecProviderSchema = z.object({
  type: z.string({
    required_error: "AgentSpec validation failed: missing required field 'provider.type'",
  }),
  model: z.string({
    required_error: "AgentSpec validation failed: missing required field 'provider.model'",
  }),
});

export const agentSpecSchema = z.object({
  name: z.string({
    required_error: "AgentSpec validation failed: missing required field 'name'",
  }),
  prompt: z.string({
    required_error: "AgentSpec validation failed: missing required field 'prompt'",
  }),
  provider: agentSpecProviderSchema,
  tools: z.array(z.string()).optional(),
});
