/**
 * The canonical spec field list: every `AgentSpecV2` key except `version`,
 * plus 'labels' (the `meta.json` labels a snapshot also carries), in the
 * order diffs and version records report changes. `SPEC_FIELD_META` gives
 * each field its display label and diff-view section; the same order backs
 * `computeChangedFields` (the `changedFields` a version record stores) and
 * `diffSpecs` (the `SpecChange[]` the diff route returns), so the Versions
 * tab's chips and the diff sheet never disagree or reshuffle.
 */
import type { AgentSpecV2 } from 'lousho';
import { stableStringify } from './stableJson';
import type { SpecSection, SpecSnapshot } from './wireTypes';

/** Every diffable field: an `AgentSpecV2` key (except `version`) or 'labels' (the meta state a snapshot carries). */
export type SpecFieldKey = Exclude<keyof AgentSpecV2, 'version'> | 'labels';

/**
 * Every field's display label and diff-view section, in canonical order.
 * Written as a `satisfies` map so adding a spec key fails typecheck here
 * until it is placed in the order deliberately - a silently-missed key
 * would otherwise never show up in `changedFields` or the diff.
 */
export const SPEC_FIELD_META = {
  name: { label: 'Name', section: 'Identity' },
  description: { label: 'Description', section: 'Identity' },
  model: { label: 'Model', section: 'Model' },
  fallbackModels: { label: 'Fallback models', section: 'Model' },
  instructions: { label: 'Instructions', section: 'Instructions' },
  instructionsByFamily: { label: 'Instructions per model family', section: 'Instructions' },
  promptRef: { label: 'Prompt reference', section: 'Instructions' },
  modelSettings: { label: 'Model settings', section: 'Model' },
  reasoning: { label: 'Reasoning', section: 'Model' },
  tools: { label: 'Tools', section: 'Tools' },
  mcpServers: { label: 'MCP servers', section: 'Tools' },
  skills: { label: 'Skills', section: 'Knowledge' },
  memory: { label: 'Memory', section: 'Knowledge' },
  subagents: { label: 'Subagents', section: 'Tools' },
  subagentOptions: { label: 'Subagent options', section: 'Tools' },
  maxSubagentDepth: { label: 'Subagent depth limit', section: 'Tools' },
  handoffs: { label: 'Handoffs', section: 'Tools' },
  maxHandoffs: { label: 'Handoff limit', section: 'Tools' },
  guardrails: { label: 'Guardrails', section: 'Safety' },
  permissions: { label: 'Permission rules', section: 'Safety' },
  permissionMode: { label: 'Permission mode', section: 'Safety' },
  approvalTtlMs: { label: 'Approval timeout', section: 'Safety' },
  askQuestion: { label: 'Ask the user questions', section: 'Safety' },
  hooks: { label: 'Hooks', section: 'Safety' },
  output: { label: 'Structured output', section: 'Instructions' },
  limits: { label: 'Run limits', section: 'Model' },
  maxSteps: { label: 'Step limit', section: 'Model' },
  compaction: { label: 'Context compaction', section: 'Model' },
  retry: { label: 'Retries', section: 'Model' },
  rateLimit: { label: 'Rate limit', section: 'Model' },
  promptCaching: { label: 'Prompt caching', section: 'Model' },
  toolSearch: { label: 'Tool search', section: 'Tools' },
  codeMode: { label: 'Code mode', section: 'Tools' },
  triggers: { label: 'Triggers', section: 'Triggers' },
  abortListeners: { label: 'Abort listeners', section: 'Triggers' },
  flow: { label: 'Flow', section: 'Flow' },
  evals: { label: 'Publish gates', section: 'Safety' },
  labels: { label: 'Labels', section: 'Identity' },
} as const satisfies Record<SpecFieldKey, { label: string; section: SpecSection }>;

/**
 * The canonical order of every diffable field: `SPEC_FIELD_META`'s keys
 * (every spec key except `version`, then 'labels'). `computeChangedFields`
 * reports in this order and the draft routes use it as the allowlist of
 * patch keys.
 */
export const SPEC_FIELD_ORDER: readonly SpecFieldKey[] = Object.keys(SPEC_FIELD_META) as SpecFieldKey[];

/**
 * A field value as comparison sees it: `undefined`, `null`, `''`, `[]` and
 * `{}` all collapse to `null` - clearing a field and never having set it are
 * the same change (an "equivalent empty" never shows as a diff).
 */
function normalise(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return null;
  if (Array.isArray(value)) return value.length === 0 ? null : value;
  if (typeof value === 'object' && Object.keys(value).length === 0) return null;
  return value;
}

/** `field`'s raw value in `snapshot`: a spec key, or `labels` for the pseudo-field of that name. */
function rawFieldValue(snapshot: SpecSnapshot | undefined, field: SpecFieldKey): unknown {
  if (snapshot === undefined) return undefined;
  if (field === 'labels') return snapshot.labels;
  return (snapshot.spec as unknown as Record<string, unknown>)[field];
}

/**
 * `field`'s value in `snapshot`, normalised for comparison: `null` when the
 * field is absent or holds an equivalent empty (`undefined`, `null`, `''`,
 * `[]`, `{}`). Both `computeChangedFields` and `diffSpecs` compare these -
 * the diff's add/remove/edit ops and the version's `changedFields` draw the
 * same line between "empty" and "set".
 */
export function specFieldValue(snapshot: SpecSnapshot | undefined, field: SpecFieldKey): unknown {
  return normalise(rawFieldValue(snapshot, field));
}

/**
 * The fields whose normalised stable JSON differs between `before` and
 * `after`, in canonical order. With `before` undefined (a first version)
 * that is every non-empty field of `after`.
 */
export function computeChangedFields(before: SpecSnapshot | undefined, after: SpecSnapshot): string[] {
  const changed: string[] = [];
  for (const field of SPEC_FIELD_ORDER) {
    if (stableStringify(specFieldValue(before, field)) !== stableStringify(specFieldValue(after, field))) {
      changed.push(field);
    }
  }
  return changed;
}
