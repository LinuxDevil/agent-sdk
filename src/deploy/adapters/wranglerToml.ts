/**
 * Merges a freshly generated wrangler.toml into the one already in the output
 * directory, so a rebuild updates only the keys the build owns and keeps what
 * the user added by hand (`[vars]`, a `[[kv_namespaces]]` binding, routes,
 * comments, a moved-forward `compatibility_date`).
 *
 * This is a line-based edit, not a TOML parser: it only needs to find
 * `key = value` lines (a value may span lines while a `[` / `{` is open) and
 * table headers, outside strings and comments.
 */

/** One key the build owns: top-level (`table` undefined) or in `[table]`. `value` undefined removes it. */
export interface OwnedTomlKey {
  table?: string;
  key: string;
  /** The TOML literal, e.g. `"dist/worker.js"`, `true` or `["0 * * * *"]`. */
  value: string | undefined;
  /** Keep the value already in the file, when there is one (`compatibility_date`). */
  keepExisting?: boolean;
}

/** How much `line` opens (+) or closes (-) `[` / `{` nesting, ignoring strings and comments. */
function nestingDelta(line: string): number {
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === '\\' && quote === '"') i++;
      else if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '#') break;
    else if (char === '[' || char === '{') depth++;
    else if (char === ']' || char === '}') depth--;
  }
  return depth;
}

interface Entry {
  /** Index of the first line. */
  start: number;
  /** Index after the last line. */
  end: number;
  /** `undefined` for top-level lines, else the table name of the header (`triggers`, `[kv_namespaces]`). */
  table: string | undefined;
  kind: 'header' | 'key' | 'other';
  key?: string;
}

const HEADER = /^\s*\[(\[?)\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/;
const KEY = /^\s*([A-Za-z0-9_.-]+|"[^"]*")\s*=/;

/** Splits `lines` into headers, (possibly multi-line) key entries and other lines, each tagged with its table. */
function entriesOf(lines: string[]): Entry[] {
  const entries: Entry[] = [];
  let table: string | undefined;
  for (let i = 0; i < lines.length; ) {
    const header = HEADER.exec(lines[i]);
    if (header) {
      table = header[1] ? `[${header[2]}]` : header[2];
      entries.push({ start: i, end: i + 1, table, kind: 'header' });
      i++;
      continue;
    }
    const key = KEY.exec(lines[i]);
    if (!key) {
      entries.push({ start: i, end: i + 1, table, kind: 'other' });
      i++;
      continue;
    }
    let depth = nestingDelta(lines[i]);
    let end = i + 1;
    while (depth > 0 && end < lines.length) depth += nestingDelta(lines[end++]);
    entries.push({ start: i, end, table, kind: 'key', key: key[1].replace(/^"|"$/g, '') });
    i = end;
  }
  return entries;
}

/** Sets (or removes) one owned key in `lines`, in place. */
function setKey(lines: string[], owned: OwnedTomlKey): void {
  const entries = entriesOf(lines);
  const found = entries.find((entry) => entry.kind === 'key' && entry.table === owned.table && entry.key === owned.key);
  if (found) {
    if (!owned.keepExisting) replaceKey(lines, found, owned);
  } else if (owned.value !== undefined) {
    insertKey(lines, entries, owned.table, `${owned.key} = ${owned.value}`);
  }
}

function replaceKey(lines: string[], found: Entry, owned: OwnedTomlKey): void {
  lines.splice(found.start, found.end - found.start, ...(owned.value === undefined ? [] : [`${owned.key} = ${owned.value}`]));
  if (owned.value === undefined && owned.table !== undefined) dropEmptyTable(lines, owned.table);
}

/** Adds `line` after the last key of `table` (top-level keys before the first table), or as a new table at the end. */
function insertKey(lines: string[], entries: Entry[], table: string | undefined, line: string): void {
  const inTable = entries.filter((entry) => entry.table === table && entry.kind !== 'other');
  if (inTable.length > 0) {
    lines.splice(inTable[inTable.length - 1].end, 0, line);
    return;
  }
  if (table === undefined) {
    const firstHeader = entries.find((entry) => entry.kind === 'header');
    lines.splice(firstHeader ? firstHeader.start : lines.length, 0, line);
    return;
  }
  if (lines.length > 0 && lines[lines.length - 1].trim() !== '') lines.push('');
  lines.push(`[${table}]`, line);
}

/** Removes `[table]`'s header when nothing but blank lines and comments is left in it. */
function dropEmptyTable(lines: string[], table: string): void {
  const entries = entriesOf(lines);
  const header = entries.find((entry) => entry.kind === 'header' && entry.table === table);
  if (!header) return;
  const body = entries.filter((entry) => entry.table === table && entry.kind !== 'header');
  if (body.some((entry) => entry.kind === 'key')) return;
  lines.splice(header.start, 1);
}

/** `existing` with each of `owned` set (or removed), every other line kept as it was. */
export function mergeWranglerToml(existing: string, owned: readonly OwnedTomlKey[]): string {
  const lines = existing.replace(/\r\n/g, '\n').split('\n');
  for (const key of owned) setKey(lines, key);
  return lines.join('\n');
}
