/**
 * LOU-X2: declarative permission policies. An ordered list of
 * {@link PermissionRule}s is checked for every tool call, after argument
 * validation and the `preToolCall` hooks and before the tool's own
 * `needsApproval`: the first rule that matches decides whether the call runs
 * (`allow`), is refused (`deny`) or waits for a human (`ask`). No match keeps
 * the tool's own behaviour.
 */

import type { ExecuteOptions } from './AgentExecutor';
import { runEventsOf } from './agentRun';

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
}

/**
 * One permission rule. Rules are checked in order; the first whose `tool`
 * matches and whose `when` (if any) returns true decides the call.
 *
 * @example
 * ```ts
 * import type { PermissionRule } from '@loushy/build-ai-agent';
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
}

/** How a tool call's permission was decided: by a rule's action, or `'default'` when no rule matched. */
export type PermissionDecision = PermissionAction | 'default';

/** One audit entry, as passed to `onPermissionDecision` and streamed as `permission.decision`. */
export interface PermissionDecisionEntry {
  toolName: string;
  toolCallId: string;
  decision: PermissionDecision;
  /** The rule that decided (its position in `permissions`); absent for `'default'`. */
  rule?: { index: number; reason?: string };
  /** The call's arguments; omitted when the run sets `redactContent`. */
  args?: Record<string, unknown>;
  /** When the decision was made, as an ISO-8601 string. */
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
   * import { allow, ask, deny } from '@loushy/build-ai-agent';
   *
   * const permissions = [deny('delete_file', 'Deleting is not allowed'), ask(['shell', 'write_file']), allow('*')];
   * ```
   */
  permissions?: readonly PermissionRule[];
  /** Called with an audit entry for every tool call's permission decision (LOU-X2). */
  onPermissionDecision?: (entry: PermissionDecisionEntry) => void;
}

/** A rule that runs the matching tools without approval. */
export function allow(tools: PermissionToolMatcher): PermissionRule {
  return { tool: tools, action: 'allow' };
}

/** A rule that refuses the matching tools; `reason` is sent to the model. */
export function deny(tools: PermissionToolMatcher, reason?: string): PermissionRule {
  return { tool: tools, action: 'deny', ...(reason !== undefined && { reason }) };
}

/** A rule that pauses the matching tools for approval, even when they do not set `needsApproval`. */
export function ask(tools: PermissionToolMatcher): PermissionRule {
  return { tool: tools, action: 'ask' };
}

function matchesTool(matcher: PermissionToolMatcher, toolName: string): boolean {
  if (typeof matcher === 'string') return matcher === '*' || matcher === toolName;
  if (matcher instanceof RegExp) return toolName.search(matcher) !== -1;
  return matcher.some((name) => matchesTool(name, toolName));
}

/** The run options a permission check reads. */
type PermissionRuntime = Pick<ExecuteOptions, 'permissions' | 'onPermissionDecision' | 'redactContent'>;

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
 * Checks `call` against the run's permission rules, reports the decision
 * (`onPermissionDecision` and, for a streaming run, a `permission.decision`
 * event) and returns it. Returns undefined - nothing checked, nothing
 * reported - when the run sets neither `permissions` nor
 * `onPermissionDecision`. A throwing `when` propagates.
 */
export async function checkPermission(
  runtime: PermissionRuntime,
  call: PermissionContext & { args: Record<string, unknown> }
): Promise<PermissionDecisionEntry | undefined> {
  const { permissions = [], onPermissionDecision, redactContent } = runtime;
  if (!runtime.permissions && !onPermissionDecision) return undefined;
  const { args, ...ctx } = call;
  const index = await firstMatch(permissions, args, ctx);
  const rule = permissions[index] as PermissionRule | undefined;
  const entry: PermissionDecisionEntry = {
    toolName: ctx.toolName,
    toolCallId: ctx.toolCallId,
    decision: rule?.action ?? 'default',
    ...(rule && { rule: { index, ...(rule.reason !== undefined && { reason: rule.reason }) } }),
    ...(!redactContent && { args }),
    at: new Date().toISOString(),
  };
  onPermissionDecision?.(entry);
  runEventsOf(runtime as ExecuteOptions)?.permissionDecision(entry);
  return entry;
}
