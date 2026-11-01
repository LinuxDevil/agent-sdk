export * from './schema';
export * from './loadSpec';
export * from './specToAgent';
export * from './policy';
export { specV2ToAgent, compileSpec } from './v2/specToAgent';
export type { CompiledSpec, SpecAgentV2 } from './v2/specToAgent';
export type { SpecHost } from './v2/host';

// AgentSpec v2: the schema, the v1→v2 upgrader, the spec-file loader and
// the spec type, re-exported by name from the package root so consumers
// (Studio's apps/agent-forge) never deep-import src/spec/v2/*.
export { agentSpecV2Schema } from './v2/schema';
export { upgradeSpec } from './v2/upgrade';
export { loadSpecV2 } from './v2/loadSpec';
export type { AgentSpecV2 } from './v2/types';

// The spec v2 section resolvers, exported for the code generated specs
// compile to (S18): one per AgentSpecV2 section, plus the JSON Schema →
// Standard Schema adapter and the secret/MCP-server expansion.
export { resolveToolRef } from './v2/resolve/tools';
export { resolveSkillRef } from './v2/resolve/skills';
export { memoryFromSpec } from './v2/resolve/memory';
export { subagentFromSpec } from './v2/resolve/subagents';
export { handoffFromSpec } from './v2/resolve/handoffs';
export { permissionsFromSpec } from './v2/resolve/permissions';
export { guardrailsFromSpec } from './v2/resolve/guardrails';
export { hooksFromSpec } from './v2/resolve/hooks';
export { outputFromSpec, jsonSchemaToStandardSchema } from './v2/jsonSchemaAdapter';
export { resolveSecretRef } from './v2/resolve/secrets';
export { resolveMcpServers } from './v2/resolve/mcpServers';
