/**
 * `spec.permissions` compiled into `createAgent({ permissions })`: each
 * entry's `tool` (a name, `'*'`, a glob or a list) becomes a
 * {@link PermissionToolMatcher} - literals and `'*'` stay strings, a glob
 * becomes one anchored RegExp - and `when`, `reason` and `ttlMs` carry over
 * through the agent-directory converter ({@link permissionRulesOf}), so spec
 * rules and agent-directory rules behave identically (same fail-closed
 * numeric comparisons, same `String(arg)` regex tests).
 *
 * `action: 'auto'` rules compile to `'ask'` - the call still pauses for a
 * decision - and are remembered in {@link SpecPermissions.isAuto}, the
 * first-match predicate `createAutoApprove` (R01) uses to send only
 * auto-rule calls to the model. With no host approver an auto rule is
 * exactly an ask rule.
 */
import { permissionRulesOf, type AgentDirPermissionRule } from '../../../agentDir/validateConfig';
import type { PermissionRule, PermissionToolMatcher } from '../../../execution/permissions';
import type { PermissionRuleSpec } from '../permissions';

/** Regex metacharacters a glob part escapes before `*` / `?` become `.*` / `.`. */
const REGEX_METACHARACTERS = /[.+^${}()|[\]\\]/g;

/** Whether `name` is a glob (contains `*` or `?`) rather than a literal tool name. */
function isGlob(name: string): boolean {
  return name.includes('*') || name.includes('?');
}

/** One glob part as a regex fragment: metacharacters escaped, then `*` → `.*` and `?` → `.`. */
function globPart(name: string): string {
  return name.replace(REGEX_METACHARACTERS, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
}

/**
 * A spec `tool` value as a {@link PermissionToolMatcher}: literals and `'*'`
 * stay strings (the SDK matcher compares them exactly); a glob, or a list
 * containing any glob, becomes one anchored RegExp `^(?:a|b)$`, so `matchesTool`
 * (which `search`es a RegExp) still requires a full match. A list containing
 * `'*'` collapses to `'*'`.
 */
export function toolMatcherOf(tool: string | readonly string[]): PermissionToolMatcher {
  const parts = typeof tool === 'string' ? [tool] : tool;
  if (parts.includes('*')) return '*';
  if (!parts.some(isGlob)) return tool;
  return new RegExp(`^(?:${parts.map(globPart).join('|')})$`);
}

/**
 * One spec rule as the agent-directory rule form `permissionRulesOf` takes.
 * `action: 'auto'` becomes `'ask'` here - the pause is identical; only
 * {@link SpecPermissions.isAuto} remembers which ask rules were auto, so the
 * compiled rules need no new action and every consumer of `permissions`
 * keeps working unchanged.
 */
function agentDirRuleOf(rule: PermissionRuleSpec): AgentDirPermissionRule {
  return {
    tool: toolMatcherOf(rule.tool),
    action: rule.action === 'auto' ? 'ask' : rule.action,
    ...(rule.when && { when: rule.when }),
    ...(rule.reason && { reason: rule.reason }),
    ...(rule.ttlMs !== undefined && { ttlMs: rule.ttlMs }),
  };
}

/** The `permissionsFromSpec` result: the compiled rules plus the auto-rule predicate. */
export interface SpecPermissions {
  /** `createAgent({ permissions })` rules, in spec order; `auto` entries are `ask`. */
  rules: PermissionRule[];
  /**
   * True when the FIRST rule matching the call (tool matcher, then `when` -
   * the SDK's own first-match order) is an `auto` rule. An `allow` or `deny`
   * rule listed before an `auto` one therefore shadows it and the model is
   * never consulted. Never calls a model; it is pure rule matching. Spec
   * `when` matchers are synchronous, so this stays sync.
   */
  isAuto: (toolName: string, args: Record<string, unknown>) => boolean;
}

/** `matchesTool` from execution/permissions.ts, kept local so this resolver stays dependency-light. */
function toolMatches(matcher: PermissionToolMatcher, toolName: string): boolean {
  if (typeof matcher === 'string') return matcher === '*' || matcher === toolName;
  if (matcher instanceof RegExp) return toolName.search(matcher) !== -1;
  return matcher.some((name) => toolMatches(name, toolName));
}

/**
 * The index of the first rule matching the call, or -1: tool matcher first,
 * then `when` - the same order and semantics `checkPermission` uses, so
 * `isAuto` can never disagree with the rule that actually decides the call.
 * A `when` returning a Promise cannot occur for spec rules (their matchers
 * compile from records to sync predicates); one would count as non-match.
 */
function firstMatchIndex(rules: readonly PermissionRule[], toolName: string, args: Record<string, unknown>): number {
  for (const [index, rule] of rules.entries()) {
    if (!toolMatches(rule.tool, toolName)) continue;
    if (rule.when !== undefined && rule.when(args, { toolName, toolCallId: '' }) !== true) continue;
    return index;
  }
  return -1;
}

/**
 * `spec.permissions` as {@link SpecPermissions}: `rules` is the
 * `createAgent({ permissions })` list (globs become anchored RegExps, `auto`
 * compiles to `ask`), `isAuto` reports whether the first matching rule was
 * an `auto` one. `autoFlags[i]` parallels `rules[i]` - `permissionRulesOf`
 * maps one-to-one, so the alignment holds.
 */
export function permissionsFromSpec(rules: readonly PermissionRuleSpec[]): SpecPermissions {
  const autoFlags = rules.map((rule) => rule.action === 'auto');
  const compiled = permissionRulesOf(
    'agent spec',
    rules.map(agentDirRuleOf)
  ) ?? [];
  return {
    rules: compiled,
    isAuto: (toolName, args) => {
      const index = firstMatchIndex(compiled, toolName, args);
      return index !== -1 && autoFlags[index] === true;
    },
  };
}
