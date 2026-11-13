/**
 * The single seam between the canvas graph model and the SDK's spec types:
 * every `graph/v2` module imports spec types from here, so the SDK import
 * path (and any SDK renames) lives in exactly one file.
 *
 * The `@linuxdevil/lousho/spec` subpath carries the spec v2 types Studio needs (the
 * browser-safe `src/spec/v2` layer), so every import here is a public SDK
 * export — no source-tree paths (PLAN §19.7, enforced by lint:imports).
 */

/** The flow the run follows (from the published `@linuxdevil/lousho/flows` subpath). */
export type { AgentFlow } from '@linuxdevil/lousho/flows';

/** The agent spec the canvas edits, plus its subagent union. */
export type { AgentSpecV2, SubagentSpec } from '@linuxdevil/lousho/spec';
/** One `spec.tools` entry. */
export type { ToolRef } from '@linuxdevil/lousho/spec';
/** A reference to an env var or a named Studio secret. */
export type { SecretRef } from '@linuxdevil/lousho/spec';
/** One `spec.skills` entry. */
export type { SkillRef } from '@linuxdevil/lousho/spec';
/** One `spec.memory` entry. */
export type { MemorySpec } from '@linuxdevil/lousho/spec';
/**
 * One `spec.mcpServers` value. The SDK names it `McpServerSpecV2`; the canvas
 * uses the shorter `McpServerSpec` everywhere, aliased once here.
 */
export type { McpServerSpecV2 as McpServerSpec } from '@linuxdevil/lousho/spec';
/** One `spec.handoffs` entry. */
export type { HandoffSpec } from '@linuxdevil/lousho/spec';
/** One `spec.guardrails` entry. */
export type { GuardrailSpec } from '@linuxdevil/lousho/spec';
/** One `spec.permissions` entry. */
export type { PermissionRuleSpec } from '@linuxdevil/lousho/spec';
/** One `spec.hooks` entry. */
export type { HookSpec } from '@linuxdevil/lousho/spec';
/** One `spec.triggers` entry. */
export type { TriggerSpec } from '@linuxdevil/lousho/spec';

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
