/**
 * Shared zod pieces for the AgentSpec v2 section schemas: entry ids, model
 * ids, paths that stay inside the agent's folder, and helpers for "check the
 * ids of a list" and "forward another schema's issues" refinements.
 * Browser-safe: no `node:*` imports.
 */
import { z } from 'zod';
import { issueMessage, typeErrors, type SchemaIssue } from '../../utils/zodCompat';

/** What {@link specIdSchema} accepts. */
// fallow-ignore-next-line unused-export -- consumed by later spec v2 section schemas (ids in error messages)
export const SPEC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Id of a list entry (guardrail, permission, hook, trigger, ...); canvas node ids are built from it. */
export const specIdSchema = z
  .string(typeErrors({ required: 'is required', invalid: 'must be a string' }))
  .regex(SPEC_ID_PATTERN, 'must be 1-64 letters, digits, dots, dashes or underscores, starting with a letter or digit');

/** What {@link modelIdSchema} accepts: 'provider/model'. */
// fallow-ignore-next-line unused-export -- consumed by later spec v2 section schemas (model ids in error messages)
export const MODEL_ID_PATTERN = /^[a-z][a-z0-9-]*\/\S+$/;

/** A model id: 'provider/model', e.g. 'anthropic/claude-sonnet-5-5'. */
export const modelIdSchema = z
  .string(typeErrors({ required: 'is required', invalid: 'must be a string' }))
  .regex(MODEL_ID_PATTERN, "must be 'provider/model', e.g. 'anthropic/claude-sonnet-5-5'");

/** A path relative to the spec's base directory: forward slashes, never escapes it. */
export function isSafeRelativePath(rel: string): boolean {
  if (rel === '' || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.includes('\\')) return false;
  let depth = 0;
  for (const segment of rel.split('/')) {
    if (segment === '..') depth -= 1;
    else if (segment !== '' && segment !== '.') depth += 1;
    if (depth < 0) return false;
  }
  return depth > 0;
}

/** The zod schema of {@link isSafeRelativePath}, for file references in the spec. */
export const relativePathSchema = z
  .string(typeErrors({ required: 'is required', invalid: 'must be a string' }))
  .refine(isSafeRelativePath, "must be a relative path with forward slashes that stays inside the agent's folder");

/** superRefine helper for a list of entries with an `id`: flags each repeat at `[index, 'id']` with "duplicate id '<id>'". */
export function refineUniqueIds(items: ReadonlyArray<{ id?: string }>, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (let index = 0; index < items.length; index++) {
    const id = items[index].id;
    if (id === undefined) continue;
    if (seen.has(id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate id '${id}'`, path: [index, 'id'] });
    } else {
      seen.add(id);
    }
  }
}

/** One issue path segment, normalized to a string or number (an object segment carries its `key`). */
function pathSegment(segment: PropertyKey | { readonly key: PropertyKey }): string | number {
  if (typeof segment === 'object') return String(segment.key);
  if (typeof segment === 'symbol') return String(segment);
  return segment;
}

/**
 * Copies a failed safeParse's issues onto `ctx` (custom issues, messages via
 * issueMessage), prefixing each path with `prefix`. Used by every section
 * whose entry is a "pick the variant, then validate it" refinement (tools,
 * hooks, ...). A v1-style "AgentSpec validation failed: " message prefix is
 * dropped: the forwarded message stands on its own.
 */
export function forwardIssues(
  result: { success: boolean; error?: { issues: readonly SchemaIssue[] } },
  ctx: z.RefinementCtx,
  prefix: (string | number)[] = []
): void {
  if (result.success || result.error === undefined) return;
  for (const issue of result.error.issues) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: issueMessage(issue).replace(/^AgentSpec validation failed: /, ''),
      path: [...prefix, ...(issue.path ?? []).map(pathSegment)],
    });
  }
}
