/**
 * The single seam between the canvas graph model and the SDK's spec types:
 * every `graph/v2` module imports spec types from here, so the SDK import
 * path (and any SDK renames) lives in exactly one file.
 *
 * The SDK's `lousho/spec` subpath only carries browser-safe exports, so the
 * spec v2 types come from the SDK source tree directly — the same deviation
 * `src/persistence/importExport.ts` already makes and documents.
 */

/** The flow the run follows (from the published `lousho/flows` subpath). */
export type { AgentFlow } from 'lousho/flows';

/** The agent spec the canvas edits, plus its subagent union. */
export type { AgentSpecV2, SubagentSpec } from '../../../../../src/spec/v2/types';
/**
 * One `spec.tools` entry, plus the SDK's own lists for the tool Inspector:
 * the credential keys each integration takes (`INTEGRATION_CREDENTIALS`),
 * the keys that must be `SecretRef`s (`SECRET_CREDENTIALS`) and the spec-id
 * pattern a `ToolRef`'s `id` follows (`SPEC_ID_PATTERN`). Value exports
 * alongside the type exports — the seam is the same.
 */
export type { ToolRef, IntegrationName, OpenApiToolRefOptions } from '../../../../../src/spec/v2/tools';
export { INTEGRATION_CREDENTIALS, SECRET_CREDENTIALS } from '../../../../../src/spec/v2/tools';
export { isSafeRelativePath, SPEC_ID_PATTERN } from '../../../../../src/spec/v2/common';
/** A reference to an env var or a named Studio secret. */
export type { SecretRef } from '../../../../../src/spec/v2/secrets';
/** One `spec.skills` entry. */
export type { SkillRef } from '../../../../../src/spec/v2/skills';
/** One `spec.memory` entry, plus its `scope`/`provider` union members for the Inspector's sub-forms. */
export type { MemorySpec, MemoryScopeSpec, MemoryProviderSpec } from '../../../../../src/spec/v2/memory';
/**
 * One `spec.mcpServers` value. The SDK names it `McpServerSpecV2`; the canvas
 * uses the shorter `McpServerSpec` everywhere, aliased once here.
 */
export type { McpServerSpecV2 as McpServerSpec } from '../../../../../src/spec/v2/mcpServers';
/** The `mcpServers` record-key pattern the SDK enforces (`^[A-Za-z0-9_-]{1,64}$`). */
export { MCP_SERVER_NAME } from '../../../../../src/spec/v2/mcpServers';
/** The longest approval deadline the spec schema accepts (`approvalTtlMs`/`ttlMs`), in ms. */
export { MAX_APPROVAL_TTL_MS } from '../../../../../src/execution/approvalTtl';
/** One `spec.handoffs` entry. */
export type { HandoffSpec } from '../../../../../src/spec/v2/handoffs';
/**
 * One `spec.guardrails` entry, plus the `guardrailSidesOf` helper the
 * Inspector and the kind validator share to read `on` (a side or a side
 * list; absent means input and output).
 */
export type { GuardrailSpec } from '../../../../../src/spec/v2/guardrails';
export { guardrailSidesOf, REWRITABLE_GUARDRAILS } from '../../../../../src/spec/v2/guardrails';
/** One `spec.permissions` entry. */
export type { PermissionRuleSpec } from '../../../../../src/spec/v2/permissions';
/** One `spec.hooks` entry, plus the `inline` member's shape for the hook Inspector. */
export type { HookSpec, InlineHookSpec } from '../../../../../src/spec/v2/hooks';
/** The agent's `spec.output` section (`jsonSchema` plus `promptSchema`/`responseFormat`). */
export type { OutputSpecV2 } from '../../../../../src/spec/v2/output';
/** The executable `AgentFlow` step types (excludes editor-only shapes) — the flow kind's validation list. */
export { EXECUTABLE_TYPES } from '../../../../../src/spec/v2/flow';
/**
 * One `spec.triggers` entry, plus the channel union and the required
 * `secrets` keys per channel kind (`CHANNEL_SECRET_KEYS`) — the SDK's own
 * list, shared by the trigger Inspector's prefill and `triggerRules`.
 */
export type { TriggerSpec, ChannelKind } from '../../../../../src/spec/v2/triggers';
export { CHANNEL_SECRET_KEYS } from '../../../../../src/spec/v2/triggers';

/** One `spec.abortListeners` entry — the SDK's own type (R03a), re-exported like the trigger types. */
export type { AbortListenerSpec } from '../../../../../src/spec/v2/abortListeners';

/**
 * The `spec.evals` gate types (X01a): the SDK's own `evals` section, shared
 * with the publish gate runner the same way the trigger/abort types are.
 */
export type { EvalGateSpec } from '../../../../../src/spec/v2/evals';
