/**
 * The structural shape of one spec field change and the pure logic that
 * decides how {@link ChangeList} draws it: a scalar as "before → after", a
 * collection as added/removed/edited chips, and long text as `+N −M` counts
 * over its line diff. Declared here (not imported from server/) so the
 * server's `SpecChange` / `LineDiff` only need to be assignable to it.
 */
import type { LineDiff, SpecChange } from '../../shared/wireTypes';

/** One line of a precomputed text diff (the server's `LineDiff` shape). */
export interface ChangeLine {
  kind: 'same' | 'removed' | 'added';
  text: string;
}

/** One field's change: what changed (`op`), and the before/after values or a line diff. */
export interface ChangeItem {
  /** Spec field name, e.g. 'model', 'tools', 'instructions'. */
  field: string;
  /** Human label for the row, e.g. 'Model', 'Tools', 'Instructions'. */
  label: string;
  op: 'add' | 'remove' | 'edit';
  before?: unknown;
  after?: unknown;
  /** Present for long text (instructions): the line diff to show under the counts. */
  lines?: ChangeLine[];
}

/**
 * A server `LineDiff` row onto {@link ChangeLine}: 'add'/'del'/'context'
 * map onto 'added'/'removed'/'same'; a collapsed 'gap' run draws as one
 * quiet context row naming the hidden line count.
 */
function toChangeLine(line: LineDiff): ChangeLine {
  if (line.kind === 'gap') {
    return { kind: 'same', text: `··· ${line.count} unchanged ${line.count === 1 ? 'line' : 'lines'}` };
  }
  if (line.kind === 'add') return { kind: 'added', text: line.text };
  if (line.kind === 'del') return { kind: 'removed', text: line.text };
  return { kind: 'same', text: line.text };
}

/**
 * A server `SpecChange` onto the {@link ChangeItem} ChangeList draws; only
 * `lines` needs the `LineDiff` → `ChangeLine` kind mapping.
 */
export function toChangeItem(change: SpecChange): ChangeItem {
  const { lines, ...rest } = change;
  return lines === undefined ? rest : { ...rest, lines: lines.map(toChangeLine) };
}

/** How one change is drawn: struck scalars, chips per collection item, or counts + a diff. */
export type ChangeView =
  | { kind: 'scalar'; before: string | null; after: string | null }
  | { kind: 'collection'; added: string[]; removed: string[]; edited: string[] }
  | { kind: 'text'; added: number; removed: number; lines: ChangeLine[] };

/** The cap on a one-line value; anything longer is ellipsised so a row stays one line. */
const MAX_VALUE_CHARS = 120;

/** Object fields that name an item, in precedence order (tool `builtin`, guardrail `id`, …). */
const TAG_KEYS = ['id', 'name', 'builtin', 'registry', 'hosted', 'file'] as const;

/** The naming field of a record (id ?? name ?? builtin ?? registry ?? hosted ?? file), as a string. */
function objectTag(value: object): string | null {
  const rec = value as Record<string, unknown>;
  for (const key of TAG_KEYS) {
    const v = rec[key];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  }
  return null;
}

/** `text` capped at {@link MAX_VALUE_CHARS}, the overflow replaced by one ellipsis. */
function ellipsise(text: string): string {
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text;
}

/**
 * A value as one line: a string as-is (ellipsised past 120 chars), a number or
 * boolean `String()`-ed, `null`/`undefined` as `null`, and an object by its
 * naming field (id ?? name ?? builtin ?? registry ?? hosted ?? file) or JSON.
 */
export function formatChangeValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return ellipsise(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const tag = objectTag(value);
    if (tag != null) return ellipsise(tag);
    const json = JSON.stringify(value);
    return json == null ? null : ellipsise(json);
  }
  return ellipsise(String(value));
}

/**
 * The key a collection item is matched by across before/after: the same
 * naming-field precedence as {@link formatChangeValue}, then JSON for
 * untagged objects and unkeyed values.
 */
export function collectionKey(item: unknown): string {
  if (item !== null && typeof item === 'object') {
    const tag = objectTag(item);
    if (tag != null) return tag;
    return JSON.stringify(item) ?? 'null';
  }
  return formatChangeValue(item) ?? JSON.stringify(item) ?? 'null';
}

/** A side of a collection diff as a key → item map (an absent or non-list side counts as empty). */
function keyedItems(side: unknown): Map<string, unknown> {
  const items = Array.isArray(side) ? side : [];
  const map = new Map<string, unknown>();
  for (const item of items) map.set(collectionKey(item), item);
  return map;
}

/** Added keys (after's order), removed keys (before's), and keys in both whose value changed. */
function collectionView(before: unknown, after: unknown): ChangeView {
  const beforeItems = keyedItems(before);
  const afterItems = keyedItems(after);
  const added: string[] = [];
  const edited: string[] = [];
  for (const [key, item] of afterItems) {
    if (!beforeItems.has(key)) added.push(key);
    else if (JSON.stringify(beforeItems.get(key)) !== JSON.stringify(item)) edited.push(key);
  }
  const removed: string[] = [];
  for (const key of beforeItems.keys()) {
    if (!afterItems.has(key)) removed.push(key);
  }
  return { kind: 'collection', added, removed, edited };
}

/**
 * How one change is drawn: `lines` makes it a text diff (counts from the
 * line kinds), either side an array makes it a collection, anything else a
 * scalar "before → after".
 */
export function changeView(change: ChangeItem): ChangeView {
  if (change.lines != null) {
    let added = 0;
    let removed = 0;
    for (const line of change.lines) {
      if (line.kind === 'added') added++;
      else if (line.kind === 'removed') removed++;
    }
    return { kind: 'text', added, removed, lines: change.lines };
  }
  if (Array.isArray(change.before) || Array.isArray(change.after)) {
    return collectionView(change.before, change.after);
  }
  return { kind: 'scalar', before: formatChangeValue(change.before), after: formatChangeValue(change.after) };
}
