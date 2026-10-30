/**
 * The AgentSpec v2 data shape. Hand-written and kept in lockstep with
 * schema.ts, like v1's `AgentSpec`: the SDK's published types do not depend
 * on the installed zod major.
 */

/** AgentSpec v2. Hand-written and kept in lockstep with schema.ts, like v1's AgentSpec. */
export interface AgentSpecV2 {
  version: 2;
  name: string;
  description?: string;
  model: string;
  fallbackModels?: string[];
  instructions: string | { file: string };
  instructionsByFamily?: Record<string, string>;
  promptRef?: string;
  // Sections not landed yet. Each later ticket replaces exactly its own line.
  tools?: never; // S04a
  skills?: never; // S14
  memory?: never; // S13
  subagents?: never; // S08
  handoffs?: never; // S09
  guardrails?: never; // S11
  permissions?: never; // S10
  hooks?: never; // S12
  output?: never; // S15
  triggers?: never; // S22
  abortListeners?: never; // R03
  flow?: never; // S21
  evals?: never; // X01
}
