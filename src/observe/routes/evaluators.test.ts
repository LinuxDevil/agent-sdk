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
    evaluators: evaluators ?? startEvaluatorWorker(database),
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
      ingestBatch(database, [
        {
          type: 'observation',
          data: { obs_id: 'kid', trace_id: 't-orphan', parent_obs_id: 'gone', kind: 'tool', start: 1, end: 2 },
        },
      ]);
      const rootless = await call(database, 'POST', `/api/v1/evaluators/${code.rule_id}/test`, { trace_id: 't-orphan' }, worker);
      expect(rootless.status).toBe(404);
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

describe('judge-job routes', () => {
  /** A worker with one queued judge job for trace t1. */
  async function queued(database: SqlDatabase, clock: { now: number }): Promise<EvaluatorWorker> {
    ingestBatch(database, [
      {
        type: 'observation',
        data: { obs_id: 'root', trace_id: 't1', agent_id: 'ag', kind: 'span', name: 'invoke_agent a', start: 1, end: 11, status: 'ok' },
      },
    ]);
    await create(database, judgeRule);
    const worker = startEvaluatorWorker(database, { isolateAvailable: () => true, now: () => clock.now });
    worker.notifyRootsEnded(['t1']);
    await worker.idle();
    return worker;
  }

  it('route order: judge-jobs never reads as a rule id', () => {
    expect(matchRoute('POST', '/api/v1/evaluators/judge-jobs/claim')?.route.path).toBe('/api/v1/evaluators/judge-jobs/claim');
    expect(matchRoute('POST', '/api/v1/evaluators/judge-jobs/j1/result')?.params).toEqual({ job_id: 'j1' });
  });

  it('claims with defaults (empty body), posts a result as an online score, then 404s the spent job', async () => {
    await withDb(async (database) => {
      const clock = { now: 1000 };
      const worker = await queued(database, clock);
      const claimed = await call(database, 'POST', '/api/v1/evaluators/judge-jobs/claim', '', worker);
      expect(claimed.status).toBe(200);
      const jobs = (claimed.body as { jobs: Array<{ job_id: string; rule: EvaluatorRuleRow; trace: { trace_id: string } }> }).jobs;
      expect(jobs).toHaveLength(1);
      expect(jobs[0].rule).toMatchObject({ name: 'helpful', kind: 'judge' });
      expect(jobs[0].trace).toMatchObject({ trace_id: 't1', agent_id: 'ag', duration_ms: 10 });
      // Leased for the default 60 s: nothing more to claim.
      clock.now += 59_000;
      expect((await call(database, 'POST', '/api/v1/evaluators/judge-jobs/claim', { max: 20 }, worker)).body).toEqual({ jobs: [] });

      const path = `/api/v1/evaluators/judge-jobs/${jobs[0].job_id}/result`;
      const posted = await call(database, 'POST', path, { value: 0.8, comment: 'good' }, worker);
      expect(posted.status).toBe(201);
      const { score_id } = posted.body as { score_id: string };
      expect(listScores(database, { trace_id: 't1', source: 'online', limit: 10 }).scores).toEqual([
        expect.objectContaining({ score_id, name: 'helpful', value: 0.8, comment: 'good' }),
      ]);
      const again = await call(database, 'POST', path, { value: 0.8 }, worker);
      expect(again.status).toBe(404);
      expect(again.body).toMatchObject(invalid);
      worker.stop();
    });
  });

  it('honours lease_ms: an expired job 404s its result and is claimable again', async () => {
    await withDb(async (database) => {
      const clock = { now: 1000 };
      const worker = await queued(database, clock);
      const first = (await call(database, 'POST', '/api/v1/evaluators/judge-jobs/claim', { max: 1, lease_ms: 1000 }, worker)).body as {
        jobs: Array<{ job_id: string }>;
      };
      clock.now += 1000;
      const late = await call(database, 'POST', `/api/v1/evaluators/judge-jobs/${first.jobs[0].job_id}/result`, { value: null }, worker);
      expect(late.status).toBe(404);
      const second = (await call(database, 'POST', '/api/v1/evaluators/judge-jobs/claim', {}, worker)).body as { jobs: Array<{ job_id: string }> };
      expect(second.jobs.map((j) => j.job_id)).toEqual([first.jobs[0].job_id]);
      worker.stop();
    });
  });

  it('400s bad claim and result bodies; 404s an unknown job', async () => {
    await withDb(async (database) => {
      const worker = await queued(database, { now: 1000 });
      const claim = (body: unknown) => call(database, 'POST', '/api/v1/evaluators/judge-jobs/claim', body, worker);
      for (const body of [{ max: 0 }, { max: 21 }, { max: 1.5 }, { lease_ms: 999 }, { lease_ms: 300_001 }, { other: 1 }, 'nope']) {
        await expect(claim(body)).rejects.toMatchObject(invalid);
      }
      const [job] = worker.claimJudgeJobs(1, 60_000);
      const result = (body: unknown) => call(database, 'POST', `/api/v1/evaluators/judge-jobs/${job.job_id}/result`, body, worker);
      for (const body of [{}, { value: 1.01 }, { value: -0.1 }, { value: '0.5' }, { value: 0.5, comment: 'x'.repeat(1001) }, { value: 0.5, extra: 1 }]) {
        await expect(result(body)).rejects.toMatchObject(invalid);
      }
      const unknown = await call(database, 'POST', '/api/v1/evaluators/judge-jobs/nope/result', { value: 1 }, worker);
      expect(unknown.status).toBe(404);
      // The leased job survived the bad bodies; a null comment is accepted.
      expect((await result({ value: 1, comment: null })).status).toBe(201);
      worker.stop();
    });
  });
});
