/**
 * The Configure tab's section model (A07): which top-level `AgentSpecV2`
 * keys each stacked card edits, the per-section JSON Schema slice the
 * SchemaForm draws, and the dirty bookkeeping that compares the draft
 * against the saved spec section by section.
 */
import type { AgentSpecV2 } from 'lousho/spec';

import { stableStringify } from '../../../../shared/stableJson';
import type { JsonSchema } from '../../../ui/schemaForm/types';

/** One stacked card of the Configure tab: its anchor id, copy and the spec keys it edits. */
export interface ConfigureSection {
  id: string;
  title: string;
  description: string;
  keys: string[];
}

/** The eight section cards, in render order; every spec key lands in exactly one (see the coverage test). */
export const CONFIGURE_SECTIONS: ConfigureSection[] = [
  {
    id: 'identity',
    title: 'Identity',
    description: 'How the agent is named and described to people and other agents.',
    keys: ['name', 'description'],
  },
  {
    id: 'model',
    title: 'Model',
    description: 'Which model runs it and how it reasons.',
    keys: ['model', 'fallbackModels', 'reasoning', 'modelSettings'],
  },
  {
    id: 'instructions',
    title: 'Instructions',
    description: 'The system prompt, per-family additions and an optional prompt-registry reference.',
    keys: ['instructions', 'instructionsByFamily', 'promptRef'],
  },
  {
    id: 'tools',
    title: 'Tools',
    description: 'Tools and MCP servers the agent can call.',
    keys: ['tools', 'mcpServers', 'toolSearch', 'codeMode'],
  },
  {
    id: 'knowledge',
    title: 'Knowledge',
    description: 'Skills, memory, subagents and handoffs.',
    keys: ['skills', 'memory', 'subagents', 'subagentOptions', 'maxSubagentDepth', 'handoffs', 'maxHandoffs'],
  },
  {
    id: 'safety',
    title: 'Safety',
    description: 'Guardrails, permission rules, approvals and hooks.',
    keys: ['guardrails', 'permissions', 'permissionMode', 'approvalTtlMs', 'askQuestion', 'hooks'],
  },
  {
    id: 'triggers',
    title: 'Triggers',
    description: 'What starts a run, and what can cancel one.',
    keys: ['triggers', 'abortListeners'],
  },
  {
    id: 'output',
    title: 'Output and limits',
    description: 'Structured output, run limits, retries and caching.',
    keys: ['output', 'limits', 'maxSteps', 'compaction', 'retry', 'rateLimit', 'promptCaching'],
  },
];

/**
 * Keys never shown on the Configure tab: `version` is fixed at 2, `flow`
 * edits on the canvas, `evals` is the publish gate (X01).
 */
export const CONFIGURE_HIDDEN_KEYS = ['version', 'flow', 'evals'];

/** The spec as a plain record, for the key lookups the section helpers do. */
function asRecord(spec: AgentSpecV2): Record<string, unknown> {
  return spec as unknown as Record<string, unknown>;
}

/**
 * An object schema holding only `keys` out of the root's `properties` (and
 * their `required` subset). `definitions`/`$defs` carry over so `$ref`s
 * inside the kept properties still resolve.
 */
export function sectionSchema(root: JsonSchema, keys: string[]): JsonSchema {
  const properties = root.properties ?? {};
  const picked: Record<string, JsonSchema> = {};
  for (const key of keys) {
    const prop = properties[key];
    if (prop !== undefined) picked[key] = prop;
  }
  const schema: JsonSchema = {
    type: 'object',
    title: root.title,
    properties: picked,
    required: (root.required ?? []).filter((key) => keys.includes(key)),
  };
  if (root.definitions !== undefined) schema.definitions = root.definitions;
  if (root.$defs !== undefined) schema.$defs = root.$defs;
  return schema;
}

/** The section's slice of a spec: only its keys that are present. */
export function pickSection(spec: AgentSpecV2, keys: string[]): Record<string, unknown> {
  const record = asRecord(spec);
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (record[key] !== undefined) picked[key] = record[key];
  }
  return picked;
}

/**
 * The section ids whose keys differ between `before` and `after`, in
 * {@link CONFIGURE_SECTIONS} order. A key counts as changed when its
 * canonical JSON (`stableStringify`, so key order alone is not a change)
 * differs; keys outside every section (`version`, `flow`, `evals`) never
 * mark a section.
 */
export function changedSections(before: AgentSpecV2, after: AgentSpecV2): string[] {
  const a = asRecord(before);
  const b = asRecord(after);
  const changed = new Set<string>();
  for (const section of CONFIGURE_SECTIONS) {
    for (const key of section.keys) {
      if (stableStringify(a[key]) !== stableStringify(b[key])) {
        changed.add(section.id);
        break;
      }
    }
  }
  return CONFIGURE_SECTIONS.map((section) => section.id).filter((id) => changed.has(id));
}

/**
 * The section id owning a field path (`'modelSettings.temperature'` →
 * `'model'`, `'tools.0.builtin'` → `'tools'`): the first path segment is
 * the spec's top-level key, and the section is the one listing it.
 * `undefined` for hidden keys and paths outside the spec.
 */
export function sectionOf(path: string): string | undefined {
  const topKey = path.split('.')[0];
  return CONFIGURE_SECTIONS.find((section) => section.keys.includes(topKey))?.id;
}
