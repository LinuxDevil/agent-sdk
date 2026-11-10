/**
 * `mergeNested` builds the `patchNode` patch for one nested agent field
 * (`limits`, `retry`, `rateLimit`, `compaction`, `subagentOptions`,
 * `toolSearch`): `patch`'s entries merge into the object's current value —
 * a `undefined` value deletes that sub-key — and the result is
 * `{ [key]: undefined }`, which deletes the key itself, once the merge
 * leaves `{}`. A current value that is not a plain object (`retry: false`,
 * `toolSearch: false`, a boolean `compaction`/`codeMode`) starts from `{}`.
 */

/** True for a plain spec object (not `null`, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The patch merging `patch` into `fields[key]`: `{ [key]: merged }`, or
 * `{ [key]: undefined }` — deleting the key — when the merge leaves `{}`.
 */
export function mergeNested(
  fields: Record<string, unknown>,
  key: string,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const base = fields[key];
  const merged: Record<string, unknown> = { ...(isRecord(base) ? base : {}) };
  for (const [subKey, value] of Object.entries(patch)) {
    if (value === undefined) delete merged[subKey];
    else merged[subKey] = value;
  }
  return { [key]: Object.keys(merged).length === 0 ? undefined : merged };
}
