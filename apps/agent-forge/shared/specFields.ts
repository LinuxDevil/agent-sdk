/**
 * The `changedFields` a version record stores: which top-level spec keys
 * (plus 'labels') differ between two snapshots, always in the canonical
 * spec field order so the Versions tab's change chips never reshuffle
 * between saves.
 */
import type { AgentSpecV2 } from 'lousho';
import { stableStringify } from './stableJson';
import type { SpecSnapshot } from './wireTypes';

/**
 * Every `AgentSpecV2` key except `version`, in canonical order. Written as a
 * `satisfies` map so adding a spec key fails typecheck here until it is
 * placed in the order deliberately - a silently-missed key would otherwise
 * never show up in `changedFields`.
 */
const SPEC_FIELDS = {
  name: true,
  description: true,
  model: true,
  fallbackModels: true,
  instructions: true,
  instructionsByFamily: true,
  promptRef: true,
  modelSettings: true,
  reasoning: true,
  tools: true,
  mcpServers: true,
  skills: true,
  memory: true,
  subagents: true,
  subagentOptions: true,
  maxSubagentDepth: true,
  handoffs: true,
  maxHandoffs: true,
  guardrails: true,
  permissions: true,
  permissionMode: true,
  approvalTtlMs: true,
  askQuestion: true,
  hooks: true,
  output: true,
  limits: true,
  maxSteps: true,
  compaction: true,
  retry: true,
  rateLimit: true,
  promptCaching: true,
  toolSearch: true,
  codeMode: true,
  triggers: true,
  abortListeners: true,
  flow: true,
  evals: true,
} as const satisfies Record<Exclude<keyof AgentSpecV2, 'version'>, true>;

/**
 * The comparison order: every spec key, then 'labels' (meta state a
 * snapshot also carries). Module-private; D10 exports it when the Versions
 * tab needs the same order for its section grouping.
 */
const SPEC_FIELD_ORDER: readonly string[] = [...Object.keys(SPEC_FIELDS), 'labels'];

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

/** `field`'s value in `snapshot`: a spec key, or `labels` for the pseudo-field of that name. */
function fieldValue(snapshot: SpecSnapshot | undefined, field: string): unknown {
  if (snapshot === undefined) return undefined;
  if (field === 'labels') return snapshot.labels;
  return (snapshot.spec as unknown as Record<string, unknown>)[field];
}

/**
 * The fields whose normalised stable JSON differs between `before` and
 * `after`, in canonical order. With `before` undefined (a first version)
 * that is every non-empty field of `after`.
 */
export function computeChangedFields(before: SpecSnapshot | undefined, after: SpecSnapshot): string[] {
  const changed: string[] = [];
  for (const field of SPEC_FIELD_ORDER) {
    if (stableStringify(normalise(fieldValue(before, field))) !== stableStringify(normalise(fieldValue(after, field)))) {
      changed.push(field);
    }
  }
  return changed;
}
