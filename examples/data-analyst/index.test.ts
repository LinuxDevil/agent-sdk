import { describe, it, expect } from 'vitest';
import { mockModel, testToolContext } from '../../src/testing';
import {
  createAnalystTools,
  createDataAnalyst,
  isReadOnlyQuery,
  NOVEMBER_REVENUE_SQL,
  QUESTION,
  scriptedAnalyst,
  seedDatabase,
} from './index';

function toolOutputs(provider: ReturnType<typeof mockModel>): string {
  const last = provider.calls[provider.calls.length - 1];
  return last.messages
    .filter((m) => m.role === 'tool')
    .map((m) => String(m.content))
    .join('\n');
}

// Direct execute() calls need a ToolExecutionContext; auth is unused here.
const ctx = testToolContext();

describe('examples/data-analyst', () => {
  it('answers "which tier had the highest revenue last month?" via schema + a join query', async () => {
    const audit: string[] = [];
    const model = scriptedAnalyst();
    const { agent } = createDataAnalyst({ provider: model, onAudit: (line) => audit.push(line) });

    const result = await agent.send(QUESTION);

    expect(result.finishReason).toBe('stop');
    expect(result.text).toContain('Gold');
    // The real SELECT ran against the real database: gold led November at 1300.
    expect(toolOutputs(model)).toContain('"tier":"gold"');
    expect(toolOutputs(model)).toContain('"revenue":1300');
    expect(toolOutputs(model)).toContain('CREATE TABLE customers'); // get_schema reached the model
    expect(audit).toContain('get_schema: allow');
    expect(audit).toContain('run_query: allow');
  });

  it('denies a DELETE at the permission layer and never touches the database', async () => {
    const db = seedDatabase();
    const audit: string[] = [];
    const model = mockModel([
      { toolCalls: [{ name: 'run_query', args: { query: 'DELETE FROM orders' } }] },
      { text: 'I cannot delete data; the database is read-only.' },
    ]);
    const { agent } = createDataAnalyst({ db, provider: model, onAudit: (line) => audit.push(line) });

    const result = await agent.send('Delete all orders.');

    expect(result.finishReason).toBe('stop');
    expect(audit).toContain('run_query: deny (Only read-only SELECT queries are allowed)');
    // The model saw the denial as a tool error with the rule's reason.
    expect(toolOutputs(model)).toContain('"kind":"denied"');
    expect(toolOutputs(model)).toContain('Only read-only SELECT queries are allowed');
    // Proof the statement never ran.
    expect(db.prepare('SELECT COUNT(*) AS n FROM orders').get()?.n).toBe(10);
    db.close();
  });

  it('rejects non-SELECT SQL inside the tool too (defense in depth)', async () => {
    const db = seedDatabase();
    const { runQuery } = createAnalystTools(db);

    // Called directly (bypassing the permission gate), the tool itself refuses.
    await expect(runQuery.execute({ query: 'DELETE FROM orders' }, ctx)).rejects.toThrow(
      /single read-only SELECT/
    );
    await expect(
      runQuery.execute({ query: 'SELECT * FROM orders; DROP TABLE orders' }, ctx)
    ).rejects.toThrow(/single read-only SELECT/);
    await expect(
      runQuery.execute({ query: 'WITH x AS (SELECT 1) DELETE FROM orders' }, ctx)
    ).rejects.toThrow(/single read-only SELECT/);

    // And a real SELECT still runs.
    const ok = await runQuery.execute({ query: NOVEMBER_REVENUE_SQL }, ctx);
    expect(ok.rows[0]).toEqual({ tier: 'gold', revenue: 1300 });
    db.close();
  });

  it('isReadOnlyQuery accepts SELECT/WITH and refuses writes', () => {
    expect(isReadOnlyQuery('select * from orders')).toBe(true);
    expect(isReadOnlyQuery('  WITH x AS (SELECT 1) SELECT * FROM x')).toBe(true);
    // `created_at` must not trip the `create` keyword (word boundaries).
    expect(isReadOnlyQuery("SELECT created_at FROM orders WHERE created_at > '2024-11-01'")).toBe(true);

    expect(isReadOnlyQuery('DELETE FROM orders')).toBe(false);
    expect(isReadOnlyQuery('DROP TABLE orders')).toBe(false);
    expect(isReadOnlyQuery('SELECT 1; SELECT 2')).toBe(false);
    expect(isReadOnlyQuery('WITH x AS (SELECT 1) INSERT INTO orders VALUES (1)')).toBe(false);
    expect(isReadOnlyQuery('PRAGMA table_info(orders)')).toBe(false);
  });
});
