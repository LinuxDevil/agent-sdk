/**
 * `diffSpecs` - the `SpecChange[]` between two spec snapshots: what
 * `GET /agents/:id/versions/:n/diff` returns and what draft cards and
 * Author proposal cards render. Plain fields produce one change each;
 * keyed lists (tools by ref name, guardrails by id, MCP servers by record
 * key, ...) produce one entry per item (`tools[web-fetch]`); instructions
 * produce one edit carrying a unified line diff.
 *
 * Empties are normalised the same way `computeChangedFields` does
 * (`specFieldValue`), so a diff never reports a change `changedFields`
 * would not list, and output order is always `SPEC_FIELD_ORDER`.
 */
import { diffLines } from 'diff';
import { SPEC_FIELD_META, SPEC_FIELD_ORDER, specFieldValue, type SpecFieldKey } from '../../shared/specFields';
import { keyedItems, skillKey, toolKey } from '../../shared/nodeIds';
import { stableStringify } from '../../shared/stableJson';
import type { LineDiff, SpecChange, SpecSnapshot } from '../../shared/wireTypes';

/** How one keyed list field turns into keyed items for the per-item diff. */
interface KeyedFieldSpec {
  /** The singular noun in `label: '<singular>: <key>'` ('Tool', 'Guardrail', ...). */
  singular: string;
  /** The list (or record) value as deduped `{ key, item }` pairs, in the value's own order. */
  itemsOf(value: unknown): Array<{ key: string; item: unknown }>;
}

/** A `{ key, item }` view of a record value (`mcpServers`, `subagents`): the record key is the diff key. */
function recordItems(value: unknown): Array<{ key: string; item: unknown }> {
  return Object.entries(value as Record<string, unknown>).map(([key, item]) => ({ key, item }));
}

/** `keyOf` for list items keyed on one own property ('id', 'name', 'agent'). */
function propKey(prop: string): (item: unknown) => string {
  return (item) => String((item as Record<string, unknown>)[prop] ?? '');
}

function listItems(keyOf: (item: never) => string): (value: unknown) => Array<{ key: string; item: unknown }> {
  return (value) => keyedItems(value as readonly never[], keyOf);
}

/**
 * The fields diffed per item rather than as one whole-field change, keyed
 * as in the canvas's stable node ids (`shared/nodeIds.ts`): lists by ref
 * name / `name` / `agent` / `id`, records (`mcpServers`, `subagents`) by
 * record key.
 */
const KEYED_FIELDS: Partial<Record<SpecFieldKey, KeyedFieldSpec>> = {
  tools: { singular: 'Tool', itemsOf: listItems(toolKey as (item: never) => string) },
  skills: { singular: 'Skill', itemsOf: listItems(skillKey as (item: never) => string) },
  memory: { singular: 'Memory', itemsOf: listItems(propKey('name') as (item: never) => string) },
  handoffs: { singular: 'Handoff', itemsOf: listItems(propKey('agent') as (item: never) => string) },
  guardrails: { singular: 'Guardrail', itemsOf: listItems(propKey('id') as (item: never) => string) },
  permissions: { singular: 'Permission rule', itemsOf: listItems(propKey('id') as (item: never) => string) },
  hooks: { singular: 'Hook', itemsOf: listItems(propKey('id') as (item: never) => string) },
  triggers: { singular: 'Trigger', itemsOf: listItems(propKey('id') as (item: never) => string) },
  abortListeners: { singular: 'Abort listener', itemsOf: listItems(propKey('id') as (item: never) => string) },
  mcpServers: { singular: 'MCP server', itemsOf: recordItems },
  subagents: { singular: 'Subagent', itemsOf: recordItems },
};

/**
 * `value` (a normalised field value, `null` when absent) as `{ key, item }`
 * pairs; `null` is the empty list - a first version still emits per-item
 * `add`s.
 */
function itemsOf(spec: KeyedFieldSpec, value: unknown): Array<{ key: string; item: unknown }> {
  return value === null ? [] : spec.itemsOf(value);
}

/**
 * The per-item changes of one keyed field: `add` for items only in after,
 * `remove` for items only in before, `edit` for same-key items whose stable
 * JSON differs. After's order first, then removed items in before's order.
 */
function diffKeyed(field: SpecFieldKey, spec: KeyedFieldSpec, before: unknown, after: unknown): SpecChange[] {
  const meta = SPEC_FIELD_META[field];
  const change = (op: SpecChange['op'], key: string, item: unknown, prev?: unknown): SpecChange => ({
    field: `${field}[${key}]`,
    label: `${spec.singular}: ${key}`,
    section: meta.section,
    op,
    ...(op === 'remove' ? { before: item } : op === 'add' ? { after: item } : { before: prev, after: item }),
  });
  const beforeItems = itemsOf(spec, before);
  const beforeByKey = new Map(beforeItems.map(({ key, item }) => [key, item]));
  const afterKeys = new Set<string>();
  const changes: SpecChange[] = [];
  for (const { key, item } of itemsOf(spec, after)) {
    afterKeys.add(key);
    if (!beforeByKey.has(key)) {
      changes.push(change('add', key, item));
    } else if (stableStringify(beforeByKey.get(key)) !== stableStringify(item)) {
      changes.push(change('edit', key, item, beforeByKey.get(key)));
    }
  }
  for (const { key, item } of beforeItems) {
    if (!afterKeys.has(key)) changes.push(change('remove', key, item));
  }
  return changes;
}

/** One whole-field change: `add` when only after has a value, `remove` when only before, `edit` for both. */
function diffPlain(field: SpecFieldKey, before: unknown, after: unknown): SpecChange {
  const meta = SPEC_FIELD_META[field];
  const base = { field, label: meta.label, section: meta.section };
  if (before === null) return { ...base, op: 'add', after };
  if (after === null) return { ...base, op: 'remove', before };
  return { ...base, op: 'edit', before, after };
}

/** One `diffLines` part as rows; a trailing '\n' splits into a spurious empty last line, dropped. */
function partRows(part: { added?: boolean; removed?: boolean; value: string }): LineDiff[] {
  const lines = part.value.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const kind: 'add' | 'del' | 'context' = part.added ? 'add' : part.removed ? 'del' : 'context';
  return lines.map((text) => ({ kind, text }));
}

/**
 * One run of `context` rows (`rows[start..end)`) appended to `out`: rows
 * within `context` of a neighbouring change stay, the middle of a longer
 * run collapses to one `{ kind: 'gap', count }`.
 */
function emitContextRun(rows: LineDiff[], start: number, end: number, context: number, out: LineDiff[]): void {
  const run = end - start;
  const lead = start === 0 ? 0 : Math.min(context, run);
  const trail = end === rows.length ? 0 : Math.min(context, run - lead);
  for (let k = 0; k < lead; k += 1) out.push(rows[start + k]);
  if (run - lead - trail > 0) out.push({ kind: 'gap', count: run - lead - trail });
  for (let k = trail; k > 0; k -= 1) out.push(rows[end - k]);
}

/**
 * The unified line diff of an instructions edit: `diffLines` rows with
 * context lines within `context` of a change kept and longer unchanged
 * runs collapsed to one `{ kind: 'gap', count }`.
 */
function lineHunks(a: string, b: string, context = 3): LineDiff[] {
  const rows = diffLines(a, b).flatMap(partRows);
  const out: LineDiff[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind !== 'context') {
      out.push(rows[i]);
      i += 1;
      continue;
    }
    let end = i;
    while (end < rows.length && rows[end].kind === 'context') end += 1;
    emitContextRun(rows, i, end, context, out);
    i = end;
  }
  return out;
}

/** One instructions change: a line diff when both sides are strings, a plain change otherwise. */
function diffInstructions(before: unknown, after: unknown): SpecChange {
  const meta = SPEC_FIELD_META.instructions;
  if (typeof before === 'string' && typeof after === 'string') {
    return {
      field: 'instructions',
      label: meta.label,
      section: meta.section,
      op: 'edit',
      before,
      after,
      lines: lineHunks(before, after),
    };
  }
  return diffPlain('instructions', before, after);
}

/**
 * The human-readable diff of two spec snapshots (or of `after` alone when
 * `before` is undefined - a first version: every present field is an
 * `add`). One change per plain field, per-item `field[key]` entries for
 * keyed lists, a `lines` line diff for instructions; always in
 * `SPEC_FIELD_ORDER`.
 */
export function diffSpecs(before: SpecSnapshot | undefined, after: SpecSnapshot): SpecChange[] {
  const changes: SpecChange[] = [];
  for (const field of SPEC_FIELD_ORDER) {
    const beforeValue = specFieldValue(before, field);
    const afterValue = specFieldValue(after, field);
    if (stableStringify(beforeValue) === stableStringify(afterValue)) continue;
    const keyed = KEYED_FIELDS[field];
    if (keyed !== undefined) {
      changes.push(...diffKeyed(field, keyed, beforeValue, afterValue));
    } else if (field === 'instructions') {
      changes.push(diffInstructions(beforeValue, afterValue));
    } else {
      changes.push(diffPlain(field, beforeValue, afterValue));
    }
  }
  return changes;
}
