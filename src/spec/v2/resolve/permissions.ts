/**
 * `spec.permissions` compiled into `createAgent({ permissions })`: each
 * entry's `tool` (a name, `'*'`, a glob or a list) becomes a
 * {@link PermissionToolMatcher} - literals and `'*'` stay strings, a glob
 * becomes one anchored RegExp - and `when`, `reason` and `ttlMs` carry over
 * through the agent-directory converter ({@link permissionRulesOf}), so spec
 * rules and agent-directory rules behave identically (same fail-closed
 * numeric comparisons, same `String(arg)` regex tests).
 */
import { permissionRulesOf, type AgentDirPermissionRule } from '../../../agentDir/validateConfig';
import { ConfigurationError } from '../../../execution/errors';
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
 * `action` narrows past the schema's 'auto': parseAgentSpecV2 has already
 * refused it, so reaching it here means the caller skipped validation.
 */
function agentDirRuleOf(rule: PermissionRuleSpec): AgentDirPermissionRule {
  if (rule.action === 'auto') {
    throw new ConfigurationError(
      "AgentSpec v2: permission action 'auto' cannot be run by this version of the SDK.",
      'permissions',
      'LOUSHO_SPEC_UNSUPPORTED'
    );
  }
  return {
    tool: toolMatcherOf(rule.tool),
    action: rule.action,
    ...(rule.when && { when: rule.when }),
    ...(rule.reason && { reason: rule.reason }),
    ...(rule.ttlMs !== undefined && { ttlMs: rule.ttlMs }),
  };
}

/** `spec.permissions` as `createAgent({ permissions })` rules, in order. Globs become anchored RegExps. */
export function permissionsFromSpec(rules: readonly PermissionRuleSpec[]): PermissionRule[] {
  return permissionRulesOf('agent spec', rules.map(agentDirRuleOf)) ?? [];
}
