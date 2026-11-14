import { PGlite } from '@electric-sql/pglite';
import type { PgPool, PgPoolClient, PgQueryable } from '../runtime/sql';

const INT8 = 20;
const NUMERIC = 1700;

export function pglitePool(dataDir?: string): PgPool {
  const db = new PGlite({ dataDir, parsers: { [INT8]: (value: string) => value, [NUMERIC]: (value: string) => value } });
  let tail: Promise<void> = Promise.resolve();
  const query: PgQueryable['query'] = async (text, values = []) => {
    const result = await db.query<Record<string, unknown>>(text, [...values]);
    return { rows: result.rows, rowCount: result.affectedRows ?? null };
  };
  return {
    query: (text, values) => {
      const run = tail.then(() => query(text, values));
      tail = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },
    async connect(): Promise<PgPoolClient> {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => (release = resolve));
      await previous;
      let released = false;
      return {
        query,
        release(error) {
          if (released) return;
          released = true;
          if (error) void query('ROLLBACK').then(undefined, () => undefined).then(release);
          else release();
        },
      };
    },
    end: () => db.close(),
  };
}
