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
/** One `spec.handoffs` entry. */
export type { HandoffSpec } from '../../../../../src/spec/v2/handoffs';
/** One `spec.guardrails` entry. */
export type { GuardrailSpec } from '../../../../../src/spec/v2/guardrails';
/** One `spec.permissions` entry. */
export type { PermissionRuleSpec } from '../../../../../src/spec/v2/permissions';
/** One `spec.hooks` entry. */
export type { HookSpec } from '../../../../../src/spec/v2/hooks';
/**
 * One `spec.triggers` entry, plus the channel union and the required
 * `secrets` keys per channel kind (`CHANNEL_SECRET_KEYS`) — the SDK's own
 * list, shared by the trigger Inspector's prefill and `triggerRules`.
 */
export type { TriggerSpec, ChannelKind } from '../../../../../src/spec/v2/triggers';
export { CHANNEL_SECRET_KEYS } from '../../../../../src/spec/v2/triggers';

/**
 * One `spec.abortListeners` entry — a trigger-correlated abort rule. The SDK
 * has not shipped this section yet (`AgentSpecV2.abortListeners` is `never`),
 * so the canvas forward-declares the planned shape here; when the SDK type
 * lands this becomes a re-export like the others.
 */
export interface AbortListenerSpec {
  /** Stable id, used for the `abort:<id>` node id. */
  id: string;
  /** Which trigger's runs this listener can cancel. */
  triggerId: string;
  /** safeExpression over the incoming event, e.g. "event.action == 'closed'". */
  when: string;
  /** safeExpression correlating to the run's trigger event, e.g. "event.pr == run.event.pr". */
  match: string;
  /** Which runs may be cancelled. */
  scope: 'queued' | 'running' | 'both';
}

/**
 * One `spec.evals` entry — a publish gate over an observe dataset. The SDK has
 * not shipped this section yet (`AgentSpecV2.evals` is `never`), so the canvas
 * forward-declares the planned shape here; when the SDK type lands this
 * becomes a re-export like the others.
 */
export interface EvalGateSpec {
  /** Observe dataset name. */
  dataset: string;
  /** Gates that all must pass. */
  gates: Array<
    | { calledTool: string }
    | { notCalledTool: string }
    | { maxCostUsd: number }
    | { maxSteps: number }
    | { judge: { model: string; rubric: string; minScore: number } }
  >;
  /** Fraction of dataset rows that must pass, 0..1. */
  minPassRate: number;
}
