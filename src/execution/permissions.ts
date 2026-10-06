/**
 * LOU-X2: declarative permission policies. An ordered list of
 * {@link PermissionRule}s is checked for every tool call, after argument
 * validation and the `preToolCall` hooks and before the tool's own
 * `needsApproval`: the first rule that matches decides whether the call runs
 * (`allow`), is refused (`deny`) or waits for a human (`ask`). No match keeps
 * the tool's own behaviour. A tool's own `needsApproval` deny still denies a
 * call an `allow` or `ask` rule matched (LOU-X8 follow-up).
 */

import type { ExecuteOptions } from './AgentExecutor';
import { runEventsOf } from './agentRun';
import type { ToolDescriptor } from '../types';
import type { HostedTool } from '../tools/hosted';
import { SDKError } from '../utils/sdkError';
import type { Principal } from '../auth/types';

/** What a matching {@link PermissionRule} does with a tool call. */
export type PermissionAction = 'allow' | 'deny' | 'ask';

/**
 * Which tools a rule covers: a name, a list of names, a pattern tested
 * against the name, or `'*'` for every tool.
 */
export type PermissionToolMatcher = string | readonly string[] | RegExp;

/** The call a {@link PermissionRule}'s `when` predicate is asked about. */
export interface PermissionContext {
  toolName: string;
  toolCallId: string;
  sessionId?: string;
  /** N10b: who the run acts for (docs/auth.md), frozen; absent for a run without one. */
  principal?: Readonly<Principal>;
}

/**
 * N10b: the second argument of `onPermissionDecision`: who the run acts for.
 * Kept out of the entry, which is also streamed as the `permission.decision`
 * event, so events and traces carry no caller identity.
 */
export interface PermissionAuditContext {
  principal?: Readonly<Principal>;
}

/**
 * One permission rule. Rules are checked in order; the first whose `tool`
 * matches and whose `when` (if any) returns true decides the call.
 *
 * @example
 * ```ts
 * import type { PermissionRule } from '@lousho/build-ai-agent';
 *
 * const rules: PermissionRule[] = [
 *   { tool: 'shell', when: (args) => String(args.command).startsWith('rm '), action: 'deny', reason: 'No deletes' },
 *   { tool: /^read_/, action: 'allow' },
 * ];
 * ```
 */
export interface PermissionRule {
  tool: PermissionToolMatcher;
  /** Narrows the rule to some calls; it receives the validated (hook-processed) arguments. */
  when?: (args: Record<string, unknown>, ctx: PermissionContext) => boolean | Promise<boolean>;
  action: PermissionAction;
  /** Why: sent to the model with a `deny`, and recorded in the audit entry. */
  reason?: string;
  /**
   * TTL: with `action: 'ask'`, how long the pause waits for a decision, in
   * milliseconds - the saved approval's `expiresAt`. Decided after it, the
   * call is denied ('approval expired'). Wins over the run's
   * `approvalTtlMs`; ignored by `allow` and `deny`.
   */
  ttlMs?: number;
}

/** How a tool call's permission was decided: by a rule's action, or `'default'` when no rule matched. */
export type PermissionDecision = PermissionAction | 'default';

/** One audit entry, as passed to `onPermissionDecision` and streamed as `permission.decision`. */
export interface PermissionDecisionEntry {
  toolName: string;
  toolCallId: string;
  decision: PermissionDecision;
  /**
   * The rule that decided (its position in `permissions`). Absent for
   * `'default'`, and for a `'deny'` that came from the tool's own
   * `needsApproval` (LOU-X8; its reason is then `reason`).
   */
  rule?: { index: number; reason?: string };
  /** LOU-X8: the reason the tool's `needsApproval` (or a `preToolCall` hook) gave when it denied the call. */
  reason?: string;
  /** LOU-X3: the `preToolCall` hook that denied the call. */
  hook?: string;
  /** The call's arguments; omitted when the run sets `redactContent`. */
  args?: Record<string, unknown>;
  /**
   * N4: the permission mode, set when it changed the call's outcome - `'plan'`
   * or `'dontAsk'` denied it (`decision: 'deny'`), `'acceptEdits'` ran a file
   * edit without asking (`decision: 'allow'`).
   */
  mode?: PermissionMode;
  /** When the decision was made, as an ISO-8601 string. */
  at: string;
}

/**
 * N4: a named preset over the permission rules and `needsApproval`
 * (docs/permission-modes.md). `'default'` changes nothing; `'plan'` refuses
 * every tool that is not read-only; `'acceptEdits'` runs file edits that would
 * ask; `'dontAsk'` refuses every call that would ask.
 */
export type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'dontAsk';

/** N4: a session's permission mode was switched (`session.setPermissionMode()`); see `onPermissionModeChange`. */
export interface PermissionModeChange {
  sessionId: string;
  from: PermissionMode;
  to: PermissionMode;
  /** When the mode was switched, as an ISO-8601 string. */
  at: string;
}

/** Permission options of `createAgent()` and `AgentExecutor.execute()`. */
export interface PermissionOptions {
  /**
   * Permission rules (LOU-X2), checked in order before each tool's
   * `needsApproval`. The first match decides: `allow` runs the call without
   * approval, `deny` gives the model a `kind: 'denied'` tool error with the
   * rule's `reason`, `ask` pauses the run for approval (or asks `approve`).
   * No match keeps today's behaviour. Sub-agents inherit them.
   *
   * @example
   * ```ts
   * import { allow, ask, deny } from '@lousho/build-ai-agent';
   *
   * const permissions = [deny('delete_file', 'Deleting is not allowed'), ask(['shell', 'write_file']), allow('*')];
   * ```
   */
  permissions?: readonly PermissionRule[];
  /**
   * Called with an audit entry for every tool call's permission decision
   * (LOU-X2); N10b: and, as the second argument, who the run acts for.
   */
  onPermissionDecision?: (entry: PermissionDecisionEntry, context: PermissionAuditContext) => void;
  /**
   * N4: named preset over `permissions` and `needsApproval`. Default 'default'.
   * A function is read at every tool call, so a mode switched mid-run applies
   * to the next call. Sub-agents inherit it (see docs/permission-modes.md).
   *
   * @example
   * ```ts
   * import { createAgent } from '@lousho/build-ai-agent';
   *
   * const agent = createAgent({ provider, instructions: 'Review the code.', tools, permissionMode: 'plan' });
   * ```
   */
  permissionMode?: PermissionMode | (() => PermissionMode);
  /**
   * N4: the audit log of mode switches, called by `session.setPermissionMode()`.
   * Each tool call's own decision still goes to `onPermissionDecision`.
   */
  onPermissionModeChange?: (change: PermissionModeChange) => void;
}

const PERMISSION_MODES: ReadonlySet<string> = new Set<PermissionMode>(['default', 'plan', 'acceptEdits', 'dontAsk']);

/** N4: throws `LOUSHO_CONFIG_INVALID` unless `mode` is a {@link PermissionMode}. */
export function assertPermissionMode(mode: unknown, where: string): asserts mode is PermissionMode {
  if (typeof mode !== 'string' || !PERMISSION_MODES.has(mode)) {
    throw new SDKError(
      `${where}: unknown permission mode ${JSON.stringify(mode)}. Use 'default', 'plan', 'acceptEdits' or 'dontAsk'.`,
      'LOUSHO_CONFIG_INVALID'
    );
  }
}

/** N4: the run's permission mode now (a function is called; an unknown value throws). */
export function permissionModeOf(runtime: Pick<PermissionOptions, 'permissionMode'>): PermissionMode {
  const mode = typeof runtime.permissionMode === 'function' ? runtime.permissionMode() : (runtime.permissionMode ?? 'default');
  assertPermissionMode(mode, 'permissionMode');
  return mode;
}

/** N4: why plan mode refused a call (the model gets it as the tool error's reason). */
export const PLAN_MODE_REASON = 'The agent is in plan mode: it may read but not change anything. Describe the change instead.';
/** N4: why dontAsk mode refused a call. */
export const DONT_ASK_REASON = 'The agent is in dontAsk mode: calls that need approval are refused.';
/** N4: the system-prompt paragraph of a run that starts in plan mode. */
export const PLAN_MODE_INSTRUCTION =
  'You are in plan mode: you may read but not change anything. Do not call tools that change files or anything else; describe the change instead.';

/** Built-in tools plan mode lets through without `readOnlyHint` (`ask_question`, `task`). */
const planModeTools = new WeakSet<object>();

/**
 * N4: marks a built-in tool as usable in plan mode although it is not
 * read-only by itself: `ask_question` (it only asks) and `task` (its
 * sub-agent inherits plan mode). Not for user tools: they declare
 * `annotations: { readOnlyHint: true }`.
 */
export function allowInPlanMode<T extends object>(tool: T): T {
  planModeTools.add(tool);
  return tool;
}

/** N4: plan mode lets a tool run when it declares `readOnlyHint: true` or is a built-in marked by {@link allowInPlanMode}. */
function isReadOnlyTool(tool: ToolDescriptor): boolean {
  return tool.metadata?.mcp?.annotations?.readOnlyHint === true || planModeTools.has(tool);
}

/**
 * N4: what the permission mode does with a call that rules, guardrails and
 * `needsApproval` did not deny: `deny` it (with the reason), `approve` it
 * (it then runs without asking), or `undefined` for no change. `tool` is
 * undefined for an unknown tool, which keeps its normal not-found error.
 */
export function permissionModeVerdict(
  mode: PermissionMode,
  tool: ToolDescriptor | undefined,
  requiresApproval: boolean
): { deny: string } | { approve: true } | undefined {
  if (mode === 'plan' && tool && !isReadOnlyTool(tool)) return { deny: PLAN_MODE_REASON };
  if (!requiresApproval) return undefined;
  if (mode === 'dontAsk') return { deny: DONT_ASK_REASON };
  if (mode === 'acceptEdits' && tool?.metadata?.editsFiles === true) return { approve: true };
  return undefined;
}

/** N1a x N4: the hosted tool types that only read (`codeInterpreter()` runs code; `hostedTool()` is unknown). */
const READ_ONLY_HOSTED_TYPES: ReadonlySet<HostedTool['type']> = new Set<HostedTool['type']>(['web_search', 'file_search']);

/**
 * N1a x N4: the hosted tools a model call may send under `mode`. The provider
 * runs a hosted tool inside the request, so no per-call check can stop it:
 * plan mode leaves out every hosted tool that is not read-only (`webSearch()`
 * and `fileSearch()` stay). The other modes send them all (a hosted call never
 * asks, so `dontAsk` has nothing to refuse).
 */
export function hostedToolsInMode(hostedTools: readonly HostedTool[] | undefined, mode: PermissionMode): readonly HostedTool[] | undefined {
  if (mode !== 'plan' || !hostedTools) return hostedTools;
  return hostedTools.filter((tool) => READ_ONLY_HOSTED_TYPES.has(tool.type));
}

/**
 * N4: a sub-agent's mode: the lead's while the lead's is not `'default'`,
 * else the sub-agent's own - except that a sub-agent whose own mode is
 * `'plan'` stays in plan mode whatever the lead's is. A function, so a switch
 * of the lead's mode applies to the sub-agent's next tool call too.
 */
export function inheritPermissionMode(
  lead: PermissionOptions['permissionMode'],
  own: PermissionOptions['permissionMode']
): PermissionOptions['permissionMode'] {
  if (lead === undefined) return own;
  if (own === undefined) return lead;
  return () => {
    const mode = permissionModeOf({ permissionMode: lead });
    const ownMode = permissionModeOf({ permissionMode: own });
    return mode === 'default' || ownMode === 'plan' ? ownMode : mode;
  };
}

/** A rule that runs the matching tools without approval. */
export function allow(tools: PermissionToolMatcher): PermissionRule {
  return { tool: tools, action: 'allow' };
}

/** A rule that refuses the matching tools; `reason` is sent to the model. */
export function deny(tools: PermissionToolMatcher, reason?: string): PermissionRule {
  return { tool: tools, action: 'deny', ...(reason !== undefined && { reason }) };
}

/**
 * A rule that pauses the matching tools for approval, even when they do not
 * set `needsApproval`. `ttlMs` bounds the pause: undecided past it, the call
 * is denied ('approval expired').
 */
export function ask(tools: PermissionToolMatcher, options?: { ttlMs?: number }): PermissionRule {
  return { tool: tools, action: 'ask', ...(options?.ttlMs !== undefined && { ttlMs: options.ttlMs }) };
}

function matchesTool(matcher: PermissionToolMatcher, toolName: string): boolean {
  if (typeof matcher === 'string') return matcher === '*' || matcher === toolName;
  if (matcher instanceof RegExp) return toolName.search(matcher) !== -1;
  return matcher.some((name) => matchesTool(name, toolName));
}

/** The run options a permission check reads. */
export type PermissionRuntime = Pick<ExecuteOptions, 'permissions' | 'onPermissionDecision' | 'redactContent' | 'permissionMode' | 'principal'>;

/** Whether the run keeps an audit log: it sets `permissions` or `onPermissionDecision`, or (N4) a mode other than `'default'`. */
function audited(runtime: PermissionRuntime, mode: PermissionMode): boolean {
  return runtime.permissions !== undefined || runtime.onPermissionDecision !== undefined || mode !== 'default';
}

/** Index of the first rule that matches the call, or -1. */
async function firstMatch(
  rules: readonly PermissionRule[],
  args: Record<string, unknown>,
  ctx: PermissionContext
): Promise<number> {
  for (const [index, rule] of rules.entries()) {
    if (matchesTool(rule.tool, ctx.toolName) && (!rule.when || (await rule.when(args, ctx)))) return index;
  }
  return -1;
}

/**
 * Checks `call` against the run's permission rules and returns the audit
 * entry, which the caller reports with {@link reportPermission} once the
 * call is decided (LOU-X8: a `'default'` may become the tool's own `'deny'`).
 * Returns undefined - nothing checked - when the run sets neither
 * `permissions` nor `onPermissionDecision` and `mode` (N4, the run's mode
 * for this call) is `'default'`. A throwing `when` propagates.
 */
export async function checkPermission(
  runtime: PermissionRuntime,
  call: PermissionContext & { args: Record<string, unknown> },
  mode: PermissionMode = 'default'
): Promise<PermissionDecisionEntry | undefined> {
  const { permissions = [] } = runtime;
  if (!audited(runtime, mode)) return undefined;
  const { args, ...ctx } = call;
  const index = await firstMatch(permissions, args, ctx);
  const rule = permissions[index] as PermissionRule | undefined;
  return {
    ...decisionEntry(runtime, call, rule?.action ?? 'default'),
    ...(rule && { rule: { index, ...(rule.reason !== undefined && { reason: rule.reason }) } }),
  };
}

function decisionEntry(
  { redactContent }: PermissionRuntime,
  { toolName, toolCallId, args }: PermissionContext & { args: Record<string, unknown> },
  decision: PermissionDecision
): PermissionDecisionEntry {
  return { toolName, toolCallId, decision, ...(!redactContent && { args }), at: new Date().toISOString() };
}

/** LOU-X3: audits a call a `preToolCall` hook denied, when the run keeps an audit log. */
export function reportHookDenial(
  runtime: PermissionRuntime,
  call: PermissionContext & { args: Record<string, unknown> },
  denial: { hook: string; reason: string }
): void {
  if (!audited(runtime, permissionModeOf(runtime))) return;
  reportPermission(runtime, { ...decisionEntry(runtime, call, 'deny'), ...denial });
}

/** TTL: the `reason` of a call denied because its approval expired before it was decided. */
export const APPROVAL_EXPIRED_REASON = 'approval expired';

/**
 * TTL: audits a call denied because its approval expired before it was
 * decided (resumeAfterApproval() applies the expiry) - a `'deny'` entry
 * like a rule's, when the run keeps an audit log.
 */
export function reportApprovalExpiry(runtime: PermissionRuntime, call: PermissionContext & { args: Record<string, unknown> }): void {
  if (!audited(runtime, permissionModeOf(runtime))) return;
  reportPermission(runtime, { ...decisionEntry(runtime, call, 'deny'), reason: APPROVAL_EXPIRED_REASON });
}

/**
 * N4: plan mode refuses a call a human approved before the switch to plan
 * mode (it is resumed by `resumeAfterApproval()`) when its tool is not
 * read-only. Returns the reason, after auditing the denial; undefined when
 * the call may run.
 */
export function planModeRefusal(
  runtime: PermissionRuntime,
  tool: ToolDescriptor | undefined,
  call: PermissionContext & { args: Record<string, unknown> }
): string | undefined {
  if (!tool || permissionModeOf(runtime) !== 'plan' || isReadOnlyTool(tool)) return undefined;
  reportPermission(runtime, { ...decisionEntry(runtime, call, 'deny'), reason: PLAN_MODE_REASON, mode: 'plan' });
  return PLAN_MODE_REASON;
}

/** Reports `entry` to `onPermissionDecision` and, for a streaming run, as a `permission.decision` event. */
export function reportPermission(runtime: PermissionRuntime, entry: PermissionDecisionEntry): void {
  runtime.onPermissionDecision?.(entry, { ...(runtime.principal && { principal: runtime.principal }) });
  runEventsOf(runtime as ExecuteOptions)?.permissionDecision(entry);
}
