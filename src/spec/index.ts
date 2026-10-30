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
