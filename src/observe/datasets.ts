/**
 * Datasets data access: named sets of eval examples (`{ input, expected }`
 * JSON values), optionally copied from a trace's root observation. Kept out
 * of store.ts so retention (`pruneBefore`) never learns about them; an
 * example's `source_trace_id` may outlive its trace.
 */

import { randomUUID } from 'node:crypto';

import type { SqlDatabase } from '../storage/sqlite/driver';

/** One dataset, with how many examples it holds. */
export interface DatasetRow {
  dataset_id: string;
  name: string;
  description: string | null;
  created_at: number;
  example_count: number;
}

/** One example; `input`/`expected` are parsed JSON values. */
export interface ExampleRow {
  example_id: string;
  dataset_id: string;
  input: unknown;
  expected: unknown | null;
  source_trace_id: string | null;
  created_at: number;
}

const DATASET_SELECT = `
  SELECT d.dataset_id, d.name, d.description, d.created_at,
    (SELECT COUNT(*) FROM dataset_examples e WHERE e.dataset_id = d.dataset_id) AS example_count
  FROM datasets d`;

function toDataset(row: Record<string, unknown>): DatasetRow {
  return {
    dataset_id: String(row.dataset_id),
    name: String(row.name),
    description: row.description === null ? null : String(row.description),
    created_at: Number(row.created_at),
    example_count: Number(row.example_count),
  };
}

function toExample(row: Record<string, unknown>): ExampleRow {
  return {
    example_id: String(row.example_id),
    dataset_id: String(row.dataset_id),
    input: JSON.parse(String(row.input)) as unknown,
    expected: row.expected === null ? null : (JSON.parse(String(row.expected)) as unknown),
    source_trace_id: row.source_trace_id === null ? null : String(row.source_trace_id),
    created_at: Number(row.created_at),
  };
}

/** The dataset called `name`, or `undefined`. */
export function getDataset(db: SqlDatabase, name: string): DatasetRow | undefined {
  const row = db.prepare(`${DATASET_SELECT} WHERE d.name = ?`).get(name);
  return row === undefined ? undefined : toDataset(row);
}

/** Create a dataset; `undefined` when the name is taken. */
export function createDataset(
  db: SqlDatabase,
  name: string,
  description: string | undefined,
  now: number = Date.now()
): DatasetRow | undefined {
  if (getDataset(db, name) !== undefined) return undefined;
  db.prepare('INSERT INTO datasets (dataset_id, name, description, created_at) VALUES (?, ?, ?, ?)').run(
    randomUUID(),
    name,
    description ?? null,
    now
  );
  return getDataset(db, name);
}

/** A page of datasets, newest first, plus the total count. */
export function listDatasets(db: SqlDatabase, limit: number, offset: number): { datasets: DatasetRow[]; total: number } {
  const rows = db.prepare(`${DATASET_SELECT} ORDER BY d.created_at DESC, d.rowid DESC LIMIT ? OFFSET ?`).all(limit, offset);
  const total = db.prepare('SELECT COUNT(*) AS n FROM datasets').get();
  return { datasets: rows.map(toDataset), total: Number(total?.n ?? 0) };
}

/** A page of a dataset's examples, oldest first (insertion order breaks ties), plus the total. */
export function listExamples(
  db: SqlDatabase,
  datasetId: string,
  limit: number,
  offset: number
): { examples: ExampleRow[]; total: number } {
  const rows = db
    .prepare('SELECT * FROM dataset_examples WHERE dataset_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ? OFFSET ?')
    .all(datasetId, limit, offset);
  const total = db.prepare('SELECT COUNT(*) AS n FROM dataset_examples WHERE dataset_id = ?').get(datasetId);
  return { examples: rows.map(toExample), total: Number(total?.n ?? 0) };
}

/** Append an example; `input`/`expected` are JSON text already. */
export function addExample(
  db: SqlDatabase,
  datasetId: string,
  example: { input: string; expected: string | null; source_trace_id: string | null },
  now: number = Date.now()
): ExampleRow {
  const exampleId = randomUUID();
  db.prepare(
    'INSERT INTO dataset_examples (example_id, dataset_id, input, expected, source_trace_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(exampleId, datasetId, example.input, example.expected, example.source_trace_id, now);
  const row = db.prepare('SELECT * FROM dataset_examples WHERE example_id = ?').get(exampleId);
  return toExample(row as Record<string, unknown>);
}

/** Delete one example of a dataset; `false` when it is not in that dataset. */
export function deleteExample(db: SqlDatabase, datasetId: string, exampleId: string): boolean {
  const result = db.prepare('DELETE FROM dataset_examples WHERE dataset_id = ? AND example_id = ?').run(datasetId, exampleId);
  return Number(result.changes) > 0;
}

/**
 * Stored observation text as JSON text: text that already parses as JSON is
 * kept as-is, anything else (plain prose) becomes a JSON string.
 */
function asJsonText(text: string): string {
  try {
    JSON.parse(text);
    return text;
  } catch {
    return JSON.stringify(text);
  }
}

/**
 * A trace's root observation input/output as example JSON text: `'no-trace'`
 * when the trace is unknown, `'no-input'` when the root captured no input.
 */
export function exampleFromTrace(
  db: SqlDatabase,
  traceId: string
): { input: string; expected: string | null } | 'no-trace' | 'no-input' {
  const root = db
    .prepare('SELECT input, output FROM observations WHERE trace_id = ? ORDER BY parent_obs_id IS NULL DESC LIMIT 1')
    .get(traceId);
  if (root === undefined) return 'no-trace';
  if (root.input === null) return 'no-input';
  return {
    input: asJsonText(String(root.input)),
    expected: root.output === null ? null : asJsonText(String(root.output)),
  };
}
