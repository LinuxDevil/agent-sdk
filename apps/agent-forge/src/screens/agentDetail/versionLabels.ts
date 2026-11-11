import { SPEC_FIELD_META } from '../../../shared/specFields';
import type { SpecChange, SpecSection, VersionKind, VersionListItem, VersionSource } from '../../../shared/wireTypes';

/**
 * Display labels for the Versions tab (L01), shared by L02/L03/L14b.
 * `FIELD_LABELS` covers every top-level `AgentSpecV2` key the version
 * records report in `changedFields`, plus 'labels' (the meta state a
 * snapshot carries); unknown keys fall back to the raw field name.
 */
export const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  description: 'Description',
  labels: 'Labels',
  model: 'Model',
  fallbackModels: 'Fallback models',
  instructions: 'Instructions',
  instructionsByFamily: 'Instructions per model family',
  promptRef: 'Prompt reference',
  modelSettings: 'Model settings',
  reasoning: 'Reasoning',
  tools: 'Tools',
  mcpServers: 'MCP servers',
  skills: 'Skills',
  memory: 'Memory',
  subagents: 'Subagents',
  subagentOptions: 'Subagent options',
  maxSubagentDepth: 'Subagent depth',
  handoffs: 'Handoffs',
  maxHandoffs: 'Handoff limit',
  guardrails: 'Guardrails',
  permissions: 'Permission rules',
  permissionMode: 'Permission mode',
  approvalTtlMs: 'Approval timeout',
  askQuestion: 'Ask questions',
  hooks: 'Hooks',
  output: 'Structured output',
  limits: 'Limits',
  maxSteps: 'Max steps',
  compaction: 'Compaction',
  retry: 'Retries',
  rateLimit: 'Rate limit',
  promptCaching: 'Prompt caching',
  toolSearch: 'Tool search',
  codeMode: 'Code mode',
  triggers: 'Triggers',
  abortListeners: 'Abort listeners',
  flow: 'Flow',
  evals: 'Eval gates',
};

/** The chip text for a changed-field key: its label, or the key itself when unmapped. */
export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

/**
 * The diff sheet's grouping for one `SpecChange` (L02): the server's
 * `SpecSection` plus 'Other', where fields the spec field table does not
 * know land - a forward-compat catch for newer spec fields.
 */
export type DiffSection = SpecSection | 'Other';

/** The fixed order the diff sheet renders sections in, whatever the change order was; 'Other' always last. */
export const SECTION_ORDER: readonly DiffSection[] = [
  'Identity',
  'Model',
  'Instructions',
  'Tools',
  'Knowledge',
  'Safety',
  'Triggers',
  'Flow',
  'Other',
];

/** The section lookup, built once from `SPEC_FIELD_META` - the same table the server's diff labels use. */
const SECTION_OF: Record<string, SpecSection> = Object.fromEntries(
  Object.entries(SPEC_FIELD_META).map(([field, meta]) => [field, meta.section]),
);

/**
 * The section a changed field groups under in the version diff sheet: the
 * top-level key's `SPEC_FIELD_META` section (`tools[web_fetch]` and
 * `mcpServers.github` both land under Tools), 'Other' for keys the table
 * does not know.
 */
export function sectionOf(field: string): DiffSection {
  return SECTION_OF[field.split(/[.[]/)[0]] ?? 'Other';
}

/**
 * `changes` bucketed by {@link sectionOf} in {@link SECTION_ORDER} order,
 * empty sections dropped: the diff sheet's sections and their rows.
 */
export function groupChanges(changes: SpecChange[]): Array<{ section: DiffSection; changes: SpecChange[] }> {
  const buckets = new Map<DiffSection, SpecChange[]>();
  for (const change of changes) {
    const section = sectionOf(change.field);
    const bucket = buckets.get(section);
    if (bucket) bucket.push(change);
    else buckets.set(section, [change]);
  }
  return SECTION_ORDER.filter((section) => buckets.has(section)).map((section) => ({
    section,
    changes: buckets.get(section)!,
  }));
}

// fallow-ignore-next-line unused-export -- contract surface: kindLabel reads it internally; L02/L03/L14b import the table directly.
export const KIND_LABELS: Record<VersionKind, string> = {
  create: 'Created',
  update: 'Edited',
  restore: 'Restored',
  baseline: 'Baseline',
  publish: 'Published',
};

export const SOURCE_LABELS: Record<VersionSource, string> = {
  editor: 'in the editor',
  author: 'via Author',
  import: 'imported',
  draft: 'from a draft',
  suggestion: 'from a suggestion',
  restore: 'by restore',
  external_file_edit: 'file edited outside Studio',
  template: 'from a template',
  copy: 'as a copy',
};

/**
 * The kind chip's text: a restore names the version it went back to
 * (`Restored from v3`); every other kind uses `KIND_LABELS`.
 */
export function kindLabel(item: VersionListItem): string {
  if (item.kind === 'restore' && item.restoredFromVersion !== null) {
    return `Restored from v${item.restoredFromVersion}`;
  }
  return KIND_LABELS[item.kind];
}

/** How long a freshly-written version may go without its summary before the tab stops showing the skeleton. */
const SUMMARY_PENDING_MS = 120_000;

/**
 * True while a `create`/`update`/`publish` version's summary is still on
 * its way: `summary` is null and the version is younger than two minutes
 * (a future `createdAt` counts as now).
 */
export function summaryPending(item: VersionListItem, now: number = Date.now()): boolean {
  if (item.summary !== null) return false;
  if (item.kind !== 'create' && item.kind !== 'update' && item.kind !== 'publish') return false;
  return now - Date.parse(item.createdAt) < SUMMARY_PENDING_MS;
}
