/**
 * parseAgentSpecV2(): the validation entry point for AgentSpec v2 data. A
 * spec that fails only on "not supported yet" placeholder sections is
 * refused with LOUSHO_SPEC_UNSUPPORTED (it is otherwise valid, so the hint
 * names the field); any other problem - alone or mixed with placeholders -
 * is LOUSHO_SPEC_INVALID like v1. Browser-safe: no `node:*` imports.
 */
import { ValidationError } from '../../execution/errors';
import { closestMatch } from '../../utils/closestMatch';
import { issueMessage, issuePath, type SchemaIssue } from '../../utils/zodCompat';
import { agentSpecV2Schema, agentSpecV2Shape } from './schema';
import { isUnsupportedIssue } from './unsupported';
import type { AgentSpecV2 } from './types';

/** One validation problem, normalized: dotted path, message, and whether it is a "not supported yet" placeholder. */
interface IssueEntry {
  path: string;
  message: string;
  unsupported: boolean;
}

/** The keys of a root `unrecognized_keys` issue (both zod majors report one with `keys`), else undefined. */
function rootUnknownKeys(issue: SchemaIssue): string[] | undefined {
  const { code, keys } = issue as { code?: string; keys?: string[] };
  if (code !== 'unrecognized_keys' || (issue.path ?? []).length > 0 || !Array.isArray(keys)) return undefined;
  return keys;
}

/** "unknown field 'x' (did you mean 'y'?)", matching loadSpec's style. */
function unknownFieldMessage(key: string): string {
  const suggestion = closestMatch(key, Object.keys(agentSpecV2Shape));
  return `unknown field '${key}'${suggestion === undefined ? '' : ` (did you mean '${suggestion}'?)`}`;
}

/** The issues of a failed safeParse as {@link IssueEntry}s, expanding root unknown keys into one entry per key. */
function issueEntries(issues: readonly SchemaIssue[]): IssueEntry[] {
  return issues.flatMap((issue) => {
    const keys = rootUnknownKeys(issue);
    if (keys !== undefined) return keys.map((key) => ({ path: key, message: unknownFieldMessage(key), unsupported: false }));
    return [{ path: issuePath(issue), message: issueMessage(issue), unsupported: isUnsupportedIssue(issue) }];
  });
}

/** `'a.b': problem; 'c': other problem` - the tail of the thrown message. */
function formatDetails(entries: readonly IssueEntry[]): string {
  return entries.map((entry) => `'${entry.path}': ${entry.message}`).join('; ');
}

/** ValidationError.errors: each issue path ('tools', 'tools.0.builtin', '(root)') to its messages. */
function errorsRecord(entries: readonly IssueEntry[]): Record<string, string[]> {
  const errors = Object.create(null) as Record<string, string[]>;
  for (const entry of entries) (errors[entry.path] ??= []).push(entry.message);
  return errors;
}

/**
 * Validates `data` as AgentSpec v2. Throws ValidationError:
 * - code 'LOUSHO_SPEC_UNSUPPORTED' when every problem is a "not supported yet" issue;
 * - code 'LOUSHO_SPEC_INVALID' otherwise (unsupported ones are listed too).
 * `errors` on the thrown error maps each issue path ('tools', 'tools.0.builtin', '(root)') to its messages.
 * `source` names the file or caller in the message.
 */
export function parseAgentSpecV2(data: unknown, source?: string): AgentSpecV2 {
  const result = agentSpecV2Schema.safeParse(data);
  if (result.success) return result.data;
  const entries = issueEntries(result.error.issues);
  const unsupportedOnly = entries.every((entry) => entry.unsupported);
  const head = unsupportedOnly
    ? `AgentSpec v2 '${source ?? 'spec'}' uses fields this SDK cannot run yet`
    : `AgentSpec v2 '${source ?? 'spec'}' failed validation`;
  throw new ValidationError(
    `${head} - ${formatDetails(entries)}`,
    errorsRecord(entries),
    unsupportedOnly ? 'LOUSHO_SPEC_UNSUPPORTED' : 'LOUSHO_SPEC_INVALID'
  );
}
