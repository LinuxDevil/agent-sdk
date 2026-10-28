/**
 * Online evaluator rules API: create/list/get/update/delete rules, with the
 * kind/config pairing, filter shape and sample rate validated.
 */
import { describe, expect, it } from 'vitest';
import type * as http from 'node:http';
import { openDb } from '../store';
import type { EvaluatorRuleRow } from '../evaluators';
import { startEvaluatorWorker, type EvaluatorWorker } from '../evaluatorWorker';
import { ingestBatch, listScores } from '../store';
import type { SqlDatabase } from '../../storage/sqlite/driver';
// Through the registry, production's load order (see scores.test.ts).
import { matchRoute } from './index';

interface Captured {
  status: number;
  body: unknown;
}

/** Calls the matched route with a recording ServerResponse stand-in. */
async function call(
  database: SqlDatabase,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  evaluators?: EvaluatorWorker
): Promise<Captured> {
  const captured: Captured = { status: 0, body: undefined };
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return res;
    },
    end(chunk?: string) {
      captured.body = chunk === undefined || chunk === '' ? undefined : JSON.parse(chunk);
    },
  } as unknown as http.ServerResponse;
  const [pathname, search = ''] = path.split('?');
  const matched = matchRoute(method, pathname);
  if (!matched) throw new Error(`no route for ${method} ${pathname}`);
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  await matched.route.handle({
    db: database,
    dbPath: ':memory:',
    req: {} as http.IncomingMessage,
    res,
    params: matched.params,
    query: new URLSearchParams(search),
    readBody: () => Promise.resolve(text),
    evaluators,
  });
  return captured;
}

async function withDb(work: (database: SqlDatabase) => Promise<void>): Promise<void> {
  const database = openDb(':memory:');
  try {
    await work(database);
  } finally {
    database.close();
  }
}

const codeRule = { name: 'length', kind: 'code', config: { source: '(trace) => 1' } };
const judgeRule = { name: 'helpful', kind: 'judge', config: { model: 'gpt-4o-mini', rubric: 'Is it helpful?' } };

const create = (database: SqlDatabase, body: unknown) => call(database, 'POST', '/api/v1/evaluators', body);
const rule = (captured: Captured) => (captured.body as { evaluator: EvaluatorRuleRow }).evaluator;
const invalid = { code: 'LOUSHO_REQUEST_INVALID' };

describe('evaluator rules API', () => {
  it('creates code and judge rules with defaults applied', async () => {
    await withDb(async (database) => {
      const code = await create(database, codeRule);
      expect(code.status).toBe(201);
      expect(rule(code)).toMatchObject({
        name: 'length',
        enabled: true,
        filter: {},
        sample_rate: 1,
        kind: 'code',
        config: { source: '(trace) => 1' },
      });
      expect(typeof rule(code).rule_id).toBe('string');
      expect(rule(code).updated_at).toBe(rule(code).created_at);

      const judge = await create(database, {
        ...judgeRule,
        name: '  helpful  ',
        enabled: false,
        sample_rate: 0.25,
        filter: { agent_id: 'support', status: 'error', name_contains: 'refund' },
      });
      expect(judge.status).toBe(201);
      expect(rule(judge)).toMatchObject({
        name: 'helpful',
        enabled: false,
        sample_rate: 0.25,
        kind: 'judge',
        filter: { agent_id: 'support', status: 'error', name_contains: 'refund' },
        config: { model: 'gpt-4o-mini', rubric: 'Is it helpful?' },
      });
    });
  });

  it('400s an unknown kind, naming the allowed kinds', async () => {
    await withDb(async (database) => {
      await expect(create(database, { ...codeRule, kind: 'regex' })).rejects.toMatchObject({
        ...invalid,
        message: expect.stringMatching(/code.*judge/),
      });
    });
  });

  it('400s a config that does not match the kind, and bad fields', async () => {
    await withDb(async (database) => {
      const bad: unknown[] = [
        { ...codeRule, config: judgeRule.config },
        { ...judgeRule, config: codeRule.config },
        { ...codeRule, config: { source: '' } },
        { ...codeRule, config: { source: 'x', extra: 1 } },
        { ...codeRule, sample_rate: 1.5 },
        { ...codeRule, sample_rate: -0.1 },
        { ...codeRule, filter: { tag: 'x' } },
        { ...codeRule, filter: { status: 'pending' } },
        { ...codeRule, filter: { agent_id: '' } },
        { ...codeRule, name: '   ' },
        { ...codeRule, unknown: true },
        { kind: 'code', config: codeRule.config },
      ];
      for (const body of bad) await expect(create(database, body)).rejects.toMatchObject(invalid);
    });
  });

  it('409s a duplicate name', async () => {
    await withDb(async (database) => {
      await create(database, codeRule);
      const dup = await create(database, { ...judgeRule, name: 'length' });
      expect(dup.status).toBe(409);
      expect(dup.body).toMatchObject(invalid);
    });
  });

  it('lists oldest first with paging and kind/enabled filters', async () => {
    await withDb(async (database) => {
      await create(database, { ...codeRule, name: 'a' });
      await create(database, { ...judgeRule, name: 'b', enabled: false });
      await create(database, { ...codeRule, name: 'c' });

      const all = await call(database, 'GET', '/api/v1/evaluators');
      expect(all.status).toBe(200);
      const body = all.body as { evaluators: EvaluatorRuleRow[]; total: number; limit: number; offset: number };
      expect(body.evaluators.map((r) => r.name)).toEqual(['a', 'b', 'c']);
      expect(body).toMatchObject({ total: 3, limit: 100, offset: 0 });

      const page = (await call(database, 'GET', '/api/v1/evaluators?limit=1&offset=1')).body as typeof body;
      expect(page.evaluators.map((r) => r.name)).toEqual(['b']);
      expect(page.total).toBe(3);

      const codes = (await call(database, 'GET', '/api/v1/evaluators?kind=code')).body as typeof body;
      expect(codes.evaluators.map((r) => r.name)).toEqual(['a', 'c']);
      expect(codes.total).toBe(2);

      const off = (await call(database, 'GET', '/api/v1/evaluators?enabled=false')).body as typeof body;
      expect(off.evaluators.map((r) => r.name)).toEqual(['b']);

      await expect(call(database, 'GET', '/api/v1/evaluators?kind=regex')).rejects.toMatchObject(invalid);
      await expect(call(database, 'GET', '/api/v1/evaluators?enabled=yes')).rejects.toMatchObject(invalid);
    });
  });

  it('gets one rule; 404s an unknown id', async () => {
    await withDb(async (database) => {
      const created = rule(await create(database, codeRule));
      const got = await call(database, 'GET', `/api/v1/evaluators/${created.rule_id}`);
      expect(got.status).toBe(200);
      expect(rule(got)).toEqual(created);
      const missing = await call(database, 'GET', '/api/v1/evaluators/nope');
      expect(missing.status).toBe(404);
      expect(missing.body).toMatchObject(invalid);
    });
  });

  it('PUT merges a partial update, bumps updated_at, and validates the merged rule', async () => {
    await withDb(async (database) => {
      const created = rule(await create(database, codeRule));
      await create(database, judgeRule);
      await new Promise((resolve) => setTimeout(resolve, 5));

      const toggled = await call(database, 'PUT', `/api/v1/evaluators/${created.rule_id}`, { enabled: false });
      expect(toggled.status).toBe(200);
      expect(rule(toggled)).toMatchObject({ enabled: false, name: 'length', config: codeRule.config });
      expect(rule(toggled).created_at).toBe(created.created_at);
      expect(rule(toggled).updated_at).toBeGreaterThan(created.updated_at);

      await expect(
        call(database, 'PUT', `/api/v1/evaluators/${created.rule_id}`, { kind: 'judge' })
      ).rejects.toMatchObject(invalid);
      const switched = await call(database, 'PUT', `/api/v1/evaluators/${created.rule_id}`, {
        kind: 'judge',
        config: judgeRule.config,
      });
      expect(rule(switched)).toMatchObject({ kind: 'judge', config: judgeRule.config });

      const renamed = await call(database, 'PUT', `/api/v1/evaluators/${created.rule_id}`, { name: 'helpful' });
      expect(renamed.status).toBe(409);
      const missing = await call(database, 'PUT', '/api/v1/evaluators/nope', { enabled: true });
      expect(missing.status).toBe(404);
    });
  });

  it('deletes a rule with 204, then 404s it', async () => {
    await withDb(async (database) => {
      const created = rule(await create(database, codeRule));
      const deleted = await call(database, 'DELETE', `/api/v1/evaluators/${created.rule_id}`);
      expect(deleted.status).toBe(204);
      expect((await call(database, 'GET', `/api/v1/evaluators/${created.rule_id}`)).status).toBe(404);
      expect((await call(database, 'DELETE', `/api/v1/evaluators/${created.rule_id}`)).status).toBe(404);
    });
  });
});

describe('POST /api/v1/evaluators/:id/test', () => {
  const seedTrace = (database: SqlDatabase): void => {
    ingestBatch(database, [
      {
        type: 'observation',
        data: { obs_id: 'root', trace_id: 't1', agent_id: 'ag', kind: 'span', name: 'invoke_agent a', start: 1, end: 11, status: 'ok' },
      },
    ]);
  };
  const fakeWorker = (database: SqlDatabase, run: (code: string, args: unknown[]) => unknown, available = true) =>
    startEvaluatorWorker(database, {
      isolateAvailable: () => available,
      sandbox: () => ({ driver: 'fake', run: async (code, opts) => run(code, opts?.args ?? []) }),
    });

  it('dry-runs the rule on the trace, ignoring enabled/filter/sample_rate, and writes no score', async () => {
    await withDb(async (database) => {
      seedTrace(database);
      const created = rule(
        await create(database, { ...codeRule, enabled: false, sample_rate: 0, filter: { agent_id: 'other' } })
      );
      const seen: unknown[] = [];
      const worker = fakeWorker(database, (code, args) => {
        seen.push(code, args[0]);
        return { value: 0.5, comment: 'half' };
      });
      const tested = await call(database, 'POST', `/api/v1/evaluators/${created.rule_id}/test`, { trace_id: 't1' }, worker);
      expect(tested.status).toBe(200);
      expect(tested.body).toEqual({ result: { value: 0.5, comment: 'half' } });
      expect(seen[0]).toBe('(trace) => 1');
      expect(seen[1]).toMatchObject({ trace_id: 't1', agent_id: 'ag', duration_ms: 10, status: 'ok' });
      expect(listScores(database, { trace_id: 't1', limit: 10 }).scores).toEqual([]);
    });
  });

  it('answers isolate_unavailable without the isolate', async () => {
    await withDb(async (database) => {
      seedTrace(database);
      const created = rule(await create(database, codeRule));
      const worker = fakeWorker(database, () => 1, false);
      const tested = await call(database, 'POST', `/api/v1/evaluators/${created.rule_id}/test`, { trace_id: 't1' }, worker);
      expect(tested.body).toEqual({ result: { value: null, comment: 'isolate_unavailable' } });
    });
  });

  it('404s an unknown rule or trace, 400s a bad body, 409s a judge rule', async () => {
    await withDb(async (database) => {
      seedTrace(database);
      const worker = fakeWorker(database, () => 1);
      const code = rule(await create(database, codeRule));
      const judge = rule(await create(database, judgeRule));
      const unknownRule = await call(database, 'POST', '/api/v1/evaluators/nope/test', { trace_id: 't1' }, worker);
      expect(unknownRule.status).toBe(404);
      const unknownTrace = await call(database, 'POST', `/api/v1/evaluators/${code.rule_id}/test`, { trace_id: 'nope' }, worker);
      expect(unknownTrace.status).toBe(404);
      expect(unknownTrace.body).toMatchObject(invalid);
      await expect(call(database, 'POST', `/api/v1/evaluators/${code.rule_id}/test`, {}, worker)).rejects.toMatchObject(invalid);
      await expect(
        call(database, 'POST', `/api/v1/evaluators/${code.rule_id}/test`, { trace_id: 't1', x: 1 }, worker)
      ).rejects.toMatchObject(invalid);
      const judged = await call(database, 'POST', `/api/v1/evaluators/${judge.rule_id}/test`, { trace_id: 't1' }, worker);
      expect(judged.status).toBe(409);
      expect(judged.body).toEqual({ error: 'judge evaluators run through Agent Forge', code: 'LOUSHO_REQUEST_INVALID' });
    });
  });
});
