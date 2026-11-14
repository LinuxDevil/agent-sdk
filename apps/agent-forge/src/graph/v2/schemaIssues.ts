/**
 * Schema-level validation for the v2 canvas: `agentSpecV2Schema.safeParse`
 * on the spec `graphToSpec` emits, with each zod issue mapped back to the
 * node whose spec path is the longest prefix of the issue path. Structural
 * problems stay in `validateGraph`'s core/kind checks; these are the
 * schema's own complaints (bad enums, patterns, missing required fields,
 * and the "not supported yet" placeholders, which become warnings).
 */
import { agentSpecV2Schema } from '@linuxdevil/lousho/spec';
// The same deep seam `specTypes.ts` uses: `UNSUPPORTED_PREFIX` is not on a
// published subpath, and it is a constant, so importing the module is cheap.
import { UNSUPPORTED_PREFIX } from '../../../../../src/spec/v2/unsupported';
import type { AgentSpecV2 } from './specTypes';
import type { Problem } from './types';

/** The parts of a zod issue this module reads (structural, so either zod major fits). */
interface SchemaIssue {
  path?: (string | number)[];
  message: string;
  params?: { code?: string };
}

/**
 * `'tools.2.builtin'`-style zod path → `'tools[2].builtin'` (the
 * `specPaths` format `graphToSpec` reports). Numbers become `[n]`
 * subscripts on the preceding segment; the first segment is bare.
 */
export function formatIssuePath(path: (string | number)[]): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else out += out === '' ? segment : `.${segment}`;
  }
  return out;
}

/** Whether the issue is a "not supported yet" placeholder (warning, not error). */
function isUnsupported(issue: SchemaIssue): boolean {
  return (
    issue.params?.code === 'LOUSHO_SPEC_UNSUPPORTED' || issue.message.startsWith(UNSUPPORTED_PREFIX)
  );
}

/**
 * The node a formatted issue path belongs to: the node whose `specPaths`
 * entry is the longest string `p` equals or continues (`p === sp`,
 * `p.startsWith(sp + '.')` or `p.startsWith(sp + '[')`); the root path `''`
 * matches everything, so a spec-level issue lands on the root agent.
 * `undefined` when no node claims the path (e.g. a note-only graph).
 */
function nodeForPath(p: string, specPaths: Readonly<Record<string, string>>): string | undefined {
  let best: string | undefined;
  let bestLength = -1;
  for (const [nodeId, sp] of Object.entries(specPaths)) {
    const match =
      sp === '' || p === sp || p.startsWith(`${sp}.`) || p.startsWith(`${sp}[`);
    if (match && sp.length > bestLength) {
      best = nodeId;
      bestLength = sp.length;
    }
  }
  return best;
}

/**
 * `agentSpecV2Schema.safeParse(spec)` mapped to `Problem`s: errors keep
 * the zod message, "not supported yet" issues become warnings reading
 * `This setting is not supported yet: <field>` (`<field>` is the spec
 * path, or the issue's own description when the path is the root).
 */
export function schemaProblems(spec: AgentSpecV2, specPaths: Record<string, string>): Problem[] {
  const result = agentSpecV2Schema.safeParse(spec);
  if (result.success) return [];
  const issues = result.error.issues as unknown as SchemaIssue[];
  const problems: Problem[] = [];
  for (const issue of issues) {
    const fieldPath = formatIssuePath(issue.path ?? []);
    const nodeId = nodeForPath(fieldPath, specPaths);
    if (nodeId === undefined) continue;
    if (isUnsupported(issue)) {
      const detail = issue.message.startsWith(UNSUPPORTED_PREFIX)
        ? issue.message.slice(UNSUPPORTED_PREFIX.length)
        : issue.message;
      problems.push({
        nodeId,
        severity: 'warning',
        message: `This setting is not supported yet: ${fieldPath === '' ? detail : fieldPath}`,
        fieldPath,
      });
    } else {
      problems.push({ nodeId, severity: 'error', message: issue.message, fieldPath });
    }
  }
  return problems;
}
