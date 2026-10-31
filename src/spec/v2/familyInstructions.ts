/**
 * familyInstructions(): AgentSpec v2's `instructionsByFamily` rule — the
 * same "model id contains the family key" matching loadAgentDir's
 * instructions/<family>.md files apply, over the spec's inline record.
 * Browser-safe: no `node:*` imports (specToCode and the browser-safe spec
 * entry reuse it).
 */

/**
 * `base` plus the `byFamily` tail whose key `modelId` contains: keys are
 * checked in insertion order and the first match wins; no match (or no
 * byFamily) returns `base` unchanged.
 */
export function familyInstructions(base: string, byFamily: Record<string, string> | undefined, modelId: string): string {
  if (byFamily === undefined) return base;
  for (const [family, text] of Object.entries(byFamily)) {
    if (family !== '' && modelId.includes(family)) return `${base}\n${text}`;
  }
  return base;
}
