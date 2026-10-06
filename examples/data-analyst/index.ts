/**
 * data-analyst - the "chat with your database" archetype (Vanna, Databricks
 * Genie, every text-to-SQL agent) assembled from Lousho's building blocks.
 *
 * The loop those products share, on one `createAgent()` call:
 *
 *   1. a natural-language question comes in
 *   2. `get_schema` lets the agent inspect the CREATE TABLEs and row counts
 *   3. `run_query` executes the SELECT the agent writes
 *   4. the agent answers with the data
 *
 * The database stays read-only by defense in depth - the way a production
 * text-to-SQL agent protects the warehouse:
 *
 *   - Layer 1 (tool): `run_query.execute()` refuses anything that is not a
 *     single SELECT/WITH statement before it touches SQLite. The model gets
 *     the refusal back as a tool error it can react to.
 *   - Layer 2 (policy): a `deny` permission rule whose `when` predicate tests
 *     the validated `query` argument refuses the same calls at the gate, so
 *     each denial is audited (`onPermissionDecision` / the
 *     `permission.decision` event) and reaches the model as a
 *     `kind: 'denied'` tool error with the rule's reason.
 *   - Layer 3 (production note): open the real connection read-only
 *     (`new DatabaseSync(path, { readOnly: true })`) or use read-only
 *     database credentials - the demo seeds an in-memory database, which
 *     must be writable while it is seeded.
 *
 * The database is Node's built-in `node:sqlite` (`DatabaseSync`), loaded
 * through the SDK's lazy driver (`src/storage/sqlite/driver.ts`): engines
 * requires Node >= 22.19, well past the 22.13 release that shipped
 * `node:sqlite` without a flag, and the lazy load keeps `@types/node` 20
 * (which has no `node:sqlite` typings) and Vite's builtin resolution happy.
 * On a Node without it, `main()` prints the driver's error and exits.
 *
 * Offline (the default) a scripted mock model walks the loop; with
 * OPENROUTER_API_KEY set it runs for real on openrouter/openai/gpt-4o-mini.
 *
 * Run with: npx tsx examples/data-analyst/index.ts
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { allow, createAgent, defineTool, type AgentHook, type LLMProvider } from '../../src';
import { loadDatabaseSync, type SqlDatabase } from '../../src/storage/sqlite/driver';
import { mockModel } from '../../src/testing';

export const LIVE_MODEL = 'openrouter/openai/gpt-4o-mini';

/** The demo question; "last month" is fixed by the demo clock in the instructions. */
export const QUESTION = 'Which customer tier had the highest revenue last month?';

// ── The read-only SQL gate ──────────────────────────────────────────────────
// Shared by the tool's own validation (layer 1) and the permission rule
// (layer 2), so both enforce exactly the same policy.

/** The statement must start with SELECT or WITH (a CTE still ends in SELECT). */
const READ_ONLY_HEAD = /^\s*(select|with)\b/i;
/** A second statement after `;` is never allowed. */
const SECOND_STATEMENT = /;\s*\S/;
/**
 * Write/DDL keywords anywhere refuse the statement - this also covers a CTE
 * that ends in a write (`WITH x AS (...) DELETE ...`). Word boundaries keep
 * column names like `created_at` from tripping `create`.
 */
const WRITE_KEYWORD =
  /\b(insert|update|delete|drop|alter|create|replace|truncate|pragma|attach|detach|vacuum|reindex|grant|revoke)\b/i;

/** Whether `sql` is a single read-only SELECT/WITH statement. */
export function isReadOnlyQuery(sql: string): boolean {
  return READ_ONLY_HEAD.test(sql) && !SECOND_STATEMENT.test(sql) && !WRITE_KEYWORD.test(sql);
}

/** Cap on rows a query may return, so a runaway SELECT cannot flood the context. */
export const MAX_ROWS = 100;

// ── The demo database ───────────────────────────────────────────────────────
// Two tables a question like QUESTION needs a join across. October's revenue
// is led by silver; November's ("last month", per the demo clock) by gold.

export function seedDatabase(): SqlDatabase {
  const DatabaseSync = loadDatabaseSync();
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      tier TEXT NOT NULL
    );
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      total REAL NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO customers (id, name, tier) VALUES
      (1, 'Alice', 'gold'),
      (2, 'Bob', 'gold'),
      (3, 'Carol', 'silver'),
      (4, 'Dan', 'silver'),
      (5, 'Erin', 'bronze');
    INSERT INTO orders (id, customer_id, total, status, created_at) VALUES
      (1, 3, 700, 'completed', '2024-10-05'),
      (2, 4, 300, 'completed', '2024-10-12'),
      (3, 1, 200, 'completed', '2024-10-20'),
      (4, 5, 90, 'refunded', '2024-10-22'),
      (5, 1, 500, 'completed', '2024-11-02'),
      (6, 2, 800, 'completed', '2024-11-15'),
      (7, 3, 400, 'completed', '2024-11-08'),
      (8, 4, 250, 'completed', '2024-11-19'),
      (9, 5, 150, 'completed', '2024-11-25'),
      (10, 2, 120, 'refunded', '2024-11-27');
  `);
  return db;
}

// ── The tools ───────────────────────────────────────────────────────────────

export function createAnalystTools(db: SqlDatabase) {
  const getSchema = defineTool({
    name: 'get_schema',
    description:
      'List the database tables with their CREATE TABLE statements and row counts. Call this before writing SQL.',
    input: z.object({}),
    annotations: { readOnlyHint: true },
    execute: async () => {
      const tables = db
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all();
      return {
        tables: tables.map((table) => ({
          name: table.name,
          createStatement: table.sql,
          rowCount: db.prepare(`SELECT COUNT(*) AS n FROM ${String(table.name)}`).get()?.n,
        })),
      };
    },
  });

  const runQuery = defineTool({
    name: 'run_query',
    description:
      'Run one read-only SELECT query against the database and return the rows as JSON. Anything that is not a single SELECT/WITH statement is refused.',
    input: z.object({
      query: z.string().describe('A single read-only SELECT statement'),
    }),
    annotations: { readOnlyHint: true },
    // Layer 1 of the read-only design: the tool itself refuses non-SELECT SQL.
    async execute({ query }) {
      if (!isReadOnlyQuery(query)) {
        throw new Error(
          `run_query only accepts a single read-only SELECT statement; refused: ${JSON.stringify(query.slice(0, 120))}`
        );
      }
      const rows = db.prepare(query).all();
      return {
        rows: rows.slice(0, MAX_ROWS),
        rowCount: Math.min(rows.length, MAX_ROWS),
        ...(rows.length > MAX_ROWS && { note: `result truncated to ${MAX_ROWS} rows` }),
      };
    },
  });

  return { getSchema, runQuery };
}

// ── The agent ───────────────────────────────────────────────────────────────

const INSTRUCTIONS = [
  'You are a data analyst answering questions about a small sales database.',
  'The current date is 2024-12-15.',
  'To answer a question: call get_schema to see the tables, run ONE read-only SELECT with run_query, then answer with the numbers it returned.',
  'Only completed orders count as revenue.',
  'Keep the final answer to one or two sentences.',
].join('\n');

export interface DataAnalystOptions {
  /** A provider/model string for live runs, e.g. `openrouter/openai/gpt-4o-mini`. */
  model?: string;
  /** A provider for offline runs and tests; used instead of `model`. */
  provider?: LLMProvider;
  /** The database to analyze; defaults to a freshly seeded in-memory one. */
  db?: SqlDatabase;
  /** Called for every permission decision: the analyst's audit log. */
  onAudit?: (line: string) => void;
  /** Called for every tool call before it runs (the demo's trace). */
  onToolCall?: (toolName: string, args: Record<string, unknown>) => void;
}

export function createDataAnalyst(options: DataAnalystOptions = {}) {
  const { onAudit = () => {}, onToolCall = () => {} } = options;
  const db = options.db ?? seedDatabase();
  const { getSchema, runQuery } = createAnalystTools(db);

  const trace: AgentHook = {
    name: 'trace-tool-calls',
    preToolCall(ctx) {
      onToolCall(ctx.toolName, ctx.args);
      return undefined;
    },
  };

  const agent = createAgent({
    name: 'data-analyst',
    instructions: INSTRUCTIONS,
    ...(options.provider ? { provider: options.provider } : { model: options.model ?? LIVE_MODEL }),
    tools: [getSchema, runQuery],
    hooks: [trace],

    // Layer 2 of the read-only design: the `when` predicate receives the
    // validated arguments, so the rule can test `args.query` itself and deny
    // a non-SELECT call before the tool runs - audited as `deny` with the
    // reason, which is also the tool error the model sees.
    permissions: [
      {
        tool: 'run_query',
        when: (args) => !isReadOnlyQuery(String(args.query ?? '')),
        action: 'deny',
        reason: 'Only read-only SELECT queries are allowed',
      },
      allow(['get_schema', 'run_query']),
    ],
    onPermissionDecision: (entry) =>
      onAudit(`${entry.toolName}: ${entry.decision}${entry.rule?.reason ? ` (${entry.rule.reason})` : ''}`),

    maxSteps: 8,
  });

  return { agent, db };
}

// ── Offline script ──────────────────────────────────────────────────────────
// What the scripted model does offline: inspect the schema, run the revenue
// join, answer. November is "last month" per the demo clock (2024-12-15).

export const NOVEMBER_REVENUE_SQL = `SELECT c.tier, SUM(o.total) AS revenue
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE o.status = 'completed'
  AND o.created_at >= '2024-11-01'
  AND o.created_at < '2024-12-01'
GROUP BY c.tier
ORDER BY revenue DESC`;

export function scriptedAnalyst() {
  return mockModel([
    { toolCalls: [{ name: 'get_schema', args: {} }] },
    { toolCalls: [{ name: 'run_query', args: { query: NOVEMBER_REVENUE_SQL } }] },
    { text: 'Gold had the highest revenue last month: $1,300 in completed orders (silver $650, bronze $150).' },
  ]);
}

// ── main() ──────────────────────────────────────────────────────────────────

async function main() {
  const live = Boolean(process.env.OPENROUTER_API_KEY);
  const onAudit = (line: string) => console.log(`  [audit] ${line}`);
  const onToolCall = (name: string, args: Record<string, unknown>) =>
    console.log(`  [tool] ${name} ${JSON.stringify(args)}`);

  let db: SqlDatabase;
  try {
    db = seedDatabase();
  } catch (error) {
    // Only reachable below Node 22.13 (engines requires >= 22.19).
    console.log(`node:sqlite is unavailable on Node ${process.versions.node}; skipping the demo.`);
    console.log(`  ${(error as Error).message}`);
    return;
  }

  const { agent } = createDataAnalyst(
    live ? { db, onAudit, onToolCall } : { db, provider: scriptedAnalyst(), onAudit, onToolCall }
  );

  console.log(live ? `Live run on ${LIVE_MODEL}` : 'Offline run with a scripted mock model');
  console.log(`\nQ: ${QUESTION}\n`);
  const result = await agent.send(QUESTION);

  console.log(`\nA: ${result.text}`);
  console.log(`finish reason: ${result.finishReason}, steps: ${result.steps ?? 'n/a'}`);
  db.close();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
