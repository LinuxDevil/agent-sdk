/**
 * The browser-safe spec layer of the SDK (`lousho/spec`): the AgentSpec v1
 * and v2 schemas, their hand-written types and the pure helpers Studio
 * needs in both its browser and server bundles — catalogs, the v1→v2
 * upgrader, the JSON Schema export, the `specToCode` generator, node-id and
 * flow validation. Nothing in this entry's import graph touches `node:*`
 * or resolves a provider, so a Vite/browser build can import it directly.
 *
 * Node-only helpers stay on the package root: `specV2ToAgent`/`compileSpec`,
 * `specToAgent`, `loadSpec`/`loadSpecV2`, the `src/spec/v2/resolve/*`
 * compilers, `files.ts`, `agentDirToSpec` (the directory read side touches
 * the filesystem; the write side, `specToAgentDir`, is pure and exported
 * here) — and `listBuiltinTools`, whose catalog builds the real tool
 * factories (`node:net` for `web_fetch`).
 */

// S01a/S01b: the v2 schema, parser, spec type and every section's spec type.
export { agentSpecV2Schema } from './schema';
export { parseAgentSpecV2 } from './parse';
export type { AgentSpecV2, AgentSpecV2Compaction, AgentSpecV2Retry, InlineAgentSpec, SubagentSpec } from './types';
export type { GuardrailSide, GuardrailSpec } from './guardrails';
export type { HandoffSpec } from './handoffs';
export type { HookPoint, HookSpec, InlineHookSpec } from './hooks';
export type { PermissionRuleSpec } from './permissions';
export type { McpServerSpecV2 } from './mcpServers';

// S02: v1 → v2 upgrader.
export { upgradeSpec } from './upgrade';

// S03: `{ env }` / `{ secret }` references.
export { isSecretRef, secretRefSchema, type SecretRef } from './secrets';

// S04a (with S04b/S05 kinds): tool references.
export { TOOL_REF_KINDS, toolRefSchema, type IntegrationName, type OpenApiToolRefOptions, type ToolRef, type ToolRefKind } from './tools';

// S07: the model catalog Studio's pickers show.
export { listModels, type ListModelsOptions, type ModelCapabilities, type ModelCatalogEntry } from '../../models/catalog';

// S11: the guardrail catalog.
export { listGuardrails, type GuardrailCatalogEntry } from '../../execution/guardrailCatalog';

// S13: memory slots.
export { memorySpecSchema, type MemoryProviderSpec, type MemoryScopeSpec, type MemorySpec } from './memory';

// S14: skill references.
export { skillRefSchema, type SkillRef } from './skills';

// S15: structured output.
export type { OutputSpecV2 } from './output';
export { jsonSchemaToStandardSchema } from './jsonSchemaAdapter';

// S17: the draft-07 JSON Schema of a spec, plus per-field copy.
export { agentSpecV2JsonSchema, SPEC_FIELD_DESCRIPTIONS } from './jsonSchema';

// S18: the TypeScript generator.
export { specToCode, type SpecToCodeOptions } from '../generators/typescript';

// S19: the pure write side of the agent-directory round trip (the read
// side, `agentDirToSpec`, reads the filesystem and stays on the root).
export { specToAgentDir, type DroppedField, type SpecToAgentDirResult } from './specToAgentDir';

// S20a–S20c: stable node ids and the span exporter that stamps them.
export { specNodeIds, type SpecNodeIds } from './nodeIds';
export { isNodeIdExporter, nodeIdExporter, nodeIdIndexOf, subAgentNodeIndexes, type NodeIdIndex } from './nodeIdExporter';

// S21b/S21c: the `flow` spec key's schema and validation.
export { flowProblems, flowSpecSchema, type FlowProblem } from './flow';
export type { AgentFlow } from '../../types/flow';

// S22a: triggers schema and catalog.
export { triggerSpecSchema, type ChannelKind, type TriggerSpec } from './triggers';
export { listTriggerTypes, type TriggerTypeInfo } from './triggerCatalog';

// v1: lets Studio drop its deep `src/spec/schema` import.
export { agentSpecSchema, type AgentSpec } from '../schema';
