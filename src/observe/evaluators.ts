/**
 * Online evaluator rules data access: which traces to score (`filter`,
 * `sample_rate`) and how (`kind` 'code' with `{ source }`, or 'judge' with
 * `{ model, rubric }`). Rules are only stored here; nothing compiles a
 * `source` or calls a model. Kept out of store.ts so retention never
 * learns about them.
 */

import { randomUUID } from 'node:crypto';

import type { SqlDatabase } from '../storage/sqlite/driver';

/** Which traces a rule applies to; every key set must match. */
export interface EvaluatorRuleFilter {
  agent_id?: string;
  status?: 'ok' | 'error';
  name_contains?: string;
}

/** A `code` rule's config: the source of `(trace) => number | { value, comment }`. */
export interface CodeEvaluatorConfig {
  source: string;
}

/** A `judge` rule's config: the model that grades and the rubric it grades by. */
export interface JudgeEvaluatorConfig {
  model: string;
  rubric: string;
}

/** The editable fields of a rule; `config` matches `kind`. */
export type EvaluatorRuleFields = {
  name: string;
  enabled: boolean;
  filter: EvaluatorRuleFilter;
  sample_rate: number;
} & ({ kind: 'code'; config: CodeEvaluatorConfig } | { kind: 'judge'; config: JudgeEvaluatorConfig });

/** One stored rule. */
export type EvaluatorRuleRow = EvaluatorRuleFields & {
  rule_id: string;
  created_at: number;
  updated_at: number;
};

function toRule(row: Record<string, unknown>): EvaluatorRuleRow {
  return {
    rule_id: String(row.rule_id),
    name: String(row.name),
    enabled: Number(row.enabled) === 1,
    filter: JSON.parse(String(row.filter)) as EvaluatorRuleFilter,
    sample_rate: Number(row.sample_rate),
    kind: String(row.kind),
    config: JSON.parse(String(row.config)) as unknown,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  } as EvaluatorRuleRow;
}

/** The rule `ruleId`, or `undefined`. */
export function getEvaluatorRule(db: SqlDatabase, ruleId: string): EvaluatorRuleRow | undefined {
  const row = db.prepare('SELECT * FROM evaluator_rules WHERE rule_id = ?').get(ruleId);
  return row === undefined ? undefined : toRule(row);
}

/** Whether a rule other than `exceptId` is called `name`. */
function nameTaken(db: SqlDatabase, name: string, exceptId: string | null): boolean {
  const row = db.prepare('SELECT rule_id FROM evaluator_rules WHERE name = ?').get(name);
  return row !== undefined && String(row.rule_id) !== exceptId;
}

/** Create a rule; `undefined` when the name is taken. */
export function createEvaluatorRule(
  db: SqlDatabase,
  fields: EvaluatorRuleFields,
  now: number = Date.now()
): EvaluatorRuleRow | undefined {
  if (nameTaken(db, fields.name, null)) return undefined;
  const ruleId = randomUUID();
  db.prepare(
    `INSERT INTO evaluator_rules (rule_id, name, enabled, filter, sample_rate, kind, config, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    ruleId,
    fields.name,
    fields.enabled ? 1 : 0,
    JSON.stringify(fields.filter),
    fields.sample_rate,
    fields.kind,
    JSON.stringify(fields.config),
    now,
    now
  );
  return getEvaluatorRule(db, ruleId);
}

/**
 * Replace a rule's fields and bump `updated_at`: `'missing'` for an unknown
 * id, `'name-taken'` when another rule has the name.
 */
export function updateEvaluatorRule(
  db: SqlDatabase,
  ruleId: string,
  fields: EvaluatorRuleFields,
  now: number = Date.now()
): EvaluatorRuleRow | 'missing' | 'name-taken' {
  const current = getEvaluatorRule(db, ruleId);
  if (current === undefined) return 'missing';
  if (nameTaken(db, fields.name, ruleId)) return 'name-taken';
  db.prepare(
    `UPDATE evaluator_rules SET name = ?, enabled = ?, filter = ?, sample_rate = ?, kind = ?, config = ?, updated_at = ?
     WHERE rule_id = ?`
  ).run(
    fields.name,
    fields.enabled ? 1 : 0,
    JSON.stringify(fields.filter),
    fields.sample_rate,
    fields.kind,
    JSON.stringify(fields.config),
    Math.max(now, current.updated_at + 1),
    ruleId
  );
  return getEvaluatorRule(db, ruleId) as EvaluatorRuleRow;
}

/** Delete a rule; `false` when it is unknown. */
export function deleteEvaluatorRule(db: SqlDatabase, ruleId: string): boolean {
  return Number(db.prepare('DELETE FROM evaluator_rules WHERE rule_id = ?').run(ruleId).changes) > 0;
}

/** A page of rules, oldest first (insertion order breaks ties), plus the total matching. */
export function listEvaluatorRules(
  db: SqlDatabase,
  options: { limit: number; offset: number; kind?: 'code' | 'judge'; enabled?: boolean }
): { evaluators: EvaluatorRuleRow[]; total: number } {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (options.kind !== undefined) {
    where.push('kind = ?');
    args.push(options.kind);
  }
  if (options.enabled !== undefined) {
    where.push('enabled = ?');
    args.push(options.enabled ? 1 : 0);
  }
  const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM evaluator_rules${clause} ORDER BY created_at ASC, rowid ASC LIMIT ? OFFSET ?`)
    .all(...args, options.limit, options.offset);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM evaluator_rules${clause}`).get(...args);
  return { evaluators: rows.map(toRule), total: Number(total?.n ?? 0) };
}
