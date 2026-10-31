/**
 * Key-order-stable serialisation helpers. Two semantically equal specs can
 * differ in object-key order on disk (hand edits, YAML round-trips); sorting
 * keys at every depth before hashing or comparing makes that difference
 * invisible.
 *
 * Lives in `shared/` (not `server/storage/`) because `specFields.ts` - which
 * the browser bundle can see - compares snapshot fields with
 * `stableStringify`, and `shared/` must not import from `server/`.
 */

/**
 * `value` with every object's keys sorted, recursively. Arrays keep their
 * order (their element objects are still key-sorted); scalars pass through.
 * Used for the canonical spec hash input (specHash.ts) and for deep-equality
 * on spec data (legacySpec.ts's merge).
 */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value !== 'object' || value === null) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * `JSON.stringify(sortKeysDeep(value))` - the equality primitive
 * `computeChangedFields` compares field values with, so a field whose keys
 * were merely reordered is not reported as changed.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}
