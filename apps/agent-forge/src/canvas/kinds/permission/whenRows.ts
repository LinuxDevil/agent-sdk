/**
 * Pure mapping between a permission rule's `item.when` record and the
 * `WhenMatcherEditor`'s row list. A plain-string matcher is the
 * 'matches pattern' row; an operator object is one row per operator
 * (`{ gt: 1, lt: 5 }` shows two rows for the same argument). `toRows`
 * never loses an argument — an operator object with no recognised
 * operator still gets a blank row — and `fromRows` merges same-argument
 * rows back into one object (a 'pattern' row mixed with operators lands
 * on the `matches` key, its exact semantic equivalent).
 */
import type { PermissionRuleSpec } from '../../../graph/v2/specTypes';

/** The `item.when` record shape: argument path → matcher. */
export type WhenMap = NonNullable<PermissionRuleSpec['when']>;

/** The editor's operator kinds; 'pattern' is the plain-string matcher form. */
export type WhenOperator = 'pattern' | 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'matches';

/** One editor row: an argument path, one operator and its operand as raw text. */
export interface WhenRow {
  arg: string;
  op: WhenOperator;
  value: string;
}

/** {@link fromRows}' result: the merged `when` (absent on no rows or any row error) and per-row errors. */
export interface ParsedWhen {
  when?: WhenMap;
  errors: (string | undefined)[];
}

const OPERATORS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'matches'] as const;
const NUMERIC_OPS: ReadonlySet<WhenOperator> = new Set(['lt', 'lte', 'gt', 'gte']);

/** `pattern` compiles as a regular expression. */
function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/** `when`'s entries as editor rows, in entry order. */
export function toRows(when: WhenMap | undefined): WhenRow[] {
  const rows: WhenRow[] = [];
  for (const [arg, matcher] of Object.entries(when ?? {})) {
    if (typeof matcher === 'string') {
      rows.push({ arg, op: 'pattern', value: matcher });
      continue;
    }
    if (typeof matcher !== 'object' || matcher === null) continue;
    const record = matcher as Record<string, unknown>;
    const present = (Object.keys(record) as WhenOperator[]).filter(
      (key) => (OPERATORS as readonly string[]).includes(key) && record[key] !== undefined,
    );
    if (present.length === 0) {
      // An empty matcher object still keeps its argument visible.
      rows.push({ arg, op: 'eq', value: '' });
      continue;
    }
    for (const op of present) {
      rows.push({ arg, op, value: String(record[op]) });
    }
  }
  return rows;
}

/** `text` as an `eq`/`ne` operand: `true`, `false`, `null` and numbers parse, anything else stays a string. */
function scalarOf(text: string): string | number | boolean | null {
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  if (text.trim() !== '' && Number.isFinite(Number(text))) return Number(text);
  return text;
}

/** Row `i`'s validation error, or `undefined` — the empty argument, non-numeric operand and regex checks. */
function rowError(row: WhenRow): string | undefined {
  if (row.arg === '') return 'A condition needs an argument name';
  if (NUMERIC_OPS.has(row.op)) {
    return row.value.trim() !== '' && Number.isFinite(Number(row.value)) ? undefined : 'Enter a number';
  }
  if (row.op === 'matches') {
    return compiles(row.value) ? undefined : 'This is not a valid regular expression';
  }
  return undefined;
}

/** Row's stored operand: parsed scalar for `eq`/`ne`, number for the numeric operators, raw text otherwise. */
function operandOf(row: WhenRow): string | number | boolean | null {
  if (row.op === 'eq' || row.op === 'ne') return scalarOf(row.value);
  if (NUMERIC_OPS.has(row.op)) return Number(row.value);
  return row.value;
}

/**
 * `rows` as a `when` record, in row order. `when` is `undefined` when
 * there are no rows or any row has an error — the editor keeps the draft
 * and emits nothing until every row parses (the `OptionalNumberField`
 * rule). A 'pattern' row alone stores the plain-string matcher; mixed
 * with other operators on the same argument it merges into `matches`.
 */
export function fromRows(rows: WhenRow[]): ParsedWhen {
  const errors = rows.map(rowError);
  if (rows.length === 0 || errors.some((message) => message !== undefined)) return { errors };
  const when: Record<string, unknown> = {};
  const argRowCounts = new Map<string, number>();
  for (const row of rows) argRowCounts.set(row.arg, (argRowCounts.get(row.arg) ?? 0) + 1);
  for (const row of rows) {
    if (row.op === 'pattern' && argRowCounts.get(row.arg) === 1) {
      when[row.arg] = row.value;
      continue;
    }
    const key = row.op === 'pattern' ? 'matches' : row.op;
    const existing = when[row.arg];
    const matcher = (typeof existing === 'object' && existing !== null ? existing : {}) as Record<
      string,
      unknown
    >;
    matcher[key] = operandOf(row);
    when[row.arg] = matcher;
  }
  return { when: when as WhenMap, errors };
}
