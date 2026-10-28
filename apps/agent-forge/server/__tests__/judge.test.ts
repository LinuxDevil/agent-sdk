/**
 * LLM-judge evaluators, the Studio half (judge.ts), against a real
 * in-process observe daemon: the loop pulls judge jobs, runs a mock judge
 * and posts the score back; a daemon that is down never breaks the loop;
 * jobs wait in the daemon while no loop runs; test-on-trace runs a judge
 * rule here as a dry run. Plus the judge-reply parser.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { once } from 'node:events';
import request from 'supertest';
import { startObserveDaemon, type ObserveDaemon } from '../../../../src/observe/daemon';
import { ingestBatch, listScores } from '../../../../src/observe/store';
import { createApp } from '../app';
import { judgePrompt, parseJudgeReply, startJudgeLoop, type JudgeFn, type JudgeLoop, type JudgeLoopOptions } from '../judge';
import { RunManager } from '../runRegistry';
import { FileCheckpointStore } from '../checkpointStore';
import { FileApprovalStore } from '../approvalStore';
import { SecretsStore } from '../secretsStore';
import { createFsAgentStore } from '../../src/persistence/fsAgentStore';

const T0 = 1_700_000_000_000;

describe('judge loop and test-on-trace', () => {
  let baseDir: string;
  let daemon: ObserveDaemon;
  let daemonUrl: string;
  const loops: JudgeLoop[] = [];
  const prevUrl = process.env.LOUSHO_OBSERVE_URL;

  beforeEach(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-judge-test-'));
    daemon = await startObserveDaemon({ dbPath: ':memory:', port: 0, sweepIntervalMs: 0, evaluators: { isolateAvailable: () => true } });
    daemonUrl = `http://127.0.0.1:${daemon.port}`;
    process.env.LOUSHO_OBSERVE_URL = daemonUrl;
  });

  afterEach(async () => {
    while (loops.length > 0) loops.pop()?.stop();
    await daemon.close();
    if (prevUrl === undefined) delete process.env.LOUSHO_OBSERVE_URL;
    else process.env.LOUSHO_OBSERVE_URL = prevUrl;
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const seedTrace = (traceId: string): void => {
    ingestBatch(daemon.db, [
      {
        type: 'observation',
        data: { obs_id: `${traceId}-root`, trace_id: traceId, agent_id: 'support', kind: 'span', name: 'invoke_agent refund-bot', start: T0, end: T0 + 50, status: 'ok', input: 'refund?', output: 'done' },
      },
    ]);
  };

  /** A judge rule created over HTTP, then one trace whose root ended (so the daemon queues a job). */
  async function judgeRuleWithJob(traceId = 't1'): Promise<string> {
    const created = await fetch(`${daemonUrl}/api/v1/evaluators`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'helpful', kind: 'judge', config: { model: 'mock', rubric: 'Is the refund handled?' } }),
    });
    expect(created.status).toBe(201);
    seedTrace(traceId);
    daemon.evaluators.notifyRootsEnded([traceId]);
    await daemon.evaluators.idle();
    return ((await created.json()) as { evaluator: { rule_id: string } }).evaluator.rule_id;
  }

  const onlineScores = (traceId: string) => listScores(daemon.db, { trace_id: traceId, source: 'online', limit: 10 }).scores;

  const loop = (judge: JudgeFn, extra: Partial<JudgeLoopOptions> = {}): JudgeLoop => {
    const started = startJudgeLoop({ secretsStore: new SecretsStore(baseDir), intervalMs: 60_000, judge, ...extra });
    loops.push(started);
    return started;
  };

  it('pulls a judge job, runs the mock judge and writes its score as an online score', async () => {
    await judgeRuleWithJob();
    const seen: unknown[] = [];
    const judge: JudgeFn = async (rule, trace) => {
      seen.push(rule.config, trace);
      return { value: 0.8, comment: 'refund handled' };
    };
    await loop(judge).tick();
    expect(seen[0]).toEqual({ model: 'mock', rubric: 'Is the refund handled?' });
    expect(seen[1]).toMatchObject({ trace_id: 't1', agent_id: 'support', input: 'refund?', output: 'done', duration_ms: 50 });
    expect(onlineScores('t1')).toEqual([expect.objectContaining({ name: 'helpful', value: 0.8, comment: 'refund handled', agent_id: 'support' })]);
    expect(daemon.evaluators.stats()).toMatchObject({ judge_queued: 0, judge_leased: 0, judge_scored: 1 });
  });

  it('a judge that throws scores null with a judge_error comment', async () => {
    await judgeRuleWithJob();
    await loop(async () => {
      throw new Error('no key for openai');
    }).tick();
    expect(onlineScores('t1')).toEqual([expect.objectContaining({ value: null, comment: 'judge_error: no key for openai' })]);
  });

  it('the default judge turns a missing provider key into a judge_error score', async () => {
    const created = await fetch(`${daemonUrl}/api/v1/evaluators`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'keyless', kind: 'judge', config: { model: 'openai/gpt-4o-mini', rubric: 'r' } }),
    });
    expect(created.status).toBe(201);
    seedTrace('t1');
    daemon.evaluators.notifyRootsEnded(['t1']);
    await daemon.evaluators.idle();
    const prevKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const started = startJudgeLoop({ secretsStore: new SecretsStore(baseDir), intervalMs: 60_000 });
      loops.push(started);
      await started.tick();
    } finally {
      if (prevKey !== undefined) process.env.OPENAI_API_KEY = prevKey;
    }
    const [score] = onlineScores('t1');
    expect(score).toMatchObject({ name: 'keyless', value: null });
    expect(score.comment).toMatch(/^judge_error: /);
    expect((score.comment ?? '').length).toBeLessThanOrEqual('judge_error: '.length + 200);
  });

  it('survives a daemon that is down: no throw, one warning per outage, and it resumes', async () => {
    await judgeRuleWithJob();
    // A closed port: bind one, take its number, close it.
    const closed = http.createServer();
    closed.listen(0, '127.0.0.1');
    await once(closed, 'listening');
    const closedUrl = `http://127.0.0.1:${(closed.address() as { port: number }).port}`;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const warnings: string[] = [];
    const started = loop(async () => ({ value: 1, comment: null }), { warn: (m) => warnings.push(m) });
    process.env.LOUSHO_OBSERVE_URL = closedUrl;
    await started.tick();
    await started.tick();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('unreachable');
    expect(onlineScores('t1')).toEqual([]);

    process.env.LOUSHO_OBSERVE_URL = daemonUrl;
    await started.tick();
    expect(onlineScores('t1')).toHaveLength(1);
  });

  it('normalizes a judge result the daemon would refuse (out of range, long comment)', async () => {
    await judgeRuleWithJob('t1');
    await loop(async () => ({ value: 7, comment: 'way out' })).tick();
    expect(onlineScores('t1')).toEqual([expect.objectContaining({ value: null, comment: 'invalid_judge_output' })]);
    seedTrace('t2');
    daemon.evaluators.notifyRootsEnded(['t2']);
    await daemon.evaluators.idle();
    await loop(async () => ({ value: 0.5, comment: 'y'.repeat(5000) })).tick();
    expect(onlineScores('t2')).toEqual([expect.objectContaining({ value: 0.5, comment: 'y'.repeat(1000) })]);
  });

  it('aborts a judge call at judgeTimeoutMs and scores it judge_error, even when the judge ignores the signal', async () => {
    await judgeRuleWithJob();
    let aborted: unknown;
    const started = loop(
      (_rule, _trace, signal) =>
        new Promise(() => {
          signal.addEventListener('abort', () => (aborted = signal.reason));
        }),
      { judgeTimeoutMs: 100 }
    );
    const begun = Date.now();
    await started.tick();
    expect(Date.now() - begun).toBeLessThan(2000);
    expect(aborted).toBeInstanceOf(Error);
    expect(onlineScores('t1')).toEqual([expect.objectContaining({ value: null, comment: 'judge_error: timed out after 100 ms' })]);
  });

  it('does not run a claimed job once its lease has run out locally (it expires and requeues)', async () => {
    await judgeRuleWithJob('t1');
    seedTrace('t2');
    daemon.evaluators.notifyRootsEnded(['t2']);
    await daemon.evaluators.idle();
    const clock = { now: Date.now() };
    const judged: string[] = [];
    const started = loop(
      async (_rule, trace) => {
        judged.push(trace.trace_id);
        clock.now += 60_000; // this call used up the whole lease
        return { value: 1, comment: null };
      },
      { leaseMs: 60_000, now: () => clock.now }
    );
    await started.tick();
    expect(judged).toEqual(['t1']);
    // t1's result posted (the daemon's own lease is still live); t2 was skipped, still leased until it expires.
    expect(daemon.evaluators.stats()).toMatchObject({ judge_scored: 1, judge_leased: 1, judge_queued: 0 });
    expect(onlineScores('t2')).toEqual([]);
  });

  it('caps a judge call at what is left of the lease', async () => {
    await judgeRuleWithJob();
    const clock = { now: Date.now() };
    let signalled: AbortSignal | undefined;
    const started = loop(
      (_rule, _trace, signal) => {
        signalled = signal;
        return new Promise(() => undefined);
      },
      // A 1150 ms lease minus the 1000 ms post margin leaves 150 ms (the clock stands still).
      { leaseMs: 1150, judgeTimeoutMs: 20_000, now: () => clock.now }
    );
    const begun = Date.now();
    await started.tick();
    expect(Date.now() - begun).toBeLessThan(2000);
    expect(signalled?.aborted).toBe(true);
    expect(onlineScores('t1')).toEqual([expect.objectContaining({ comment: 'judge_error: timed out after 150 ms' })]);
  });

  it('warns once per outage for a 2xx claim answer that is not JSON', async () => {
    const warnings: string[] = [];
    const notJson = (async () => new Response('<html>proxy</html>', { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch;
    const started = loop(async () => ({ value: 1, comment: null }), { fetch: notJson, warn: (m) => warnings.push(m) });
    await started.tick();
    await started.tick();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('without a jobs array');
  });

  it('without a loop the job stays queued (nothing claims it)', async () => {
    await judgeRuleWithJob();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(daemon.evaluators.stats()).toMatchObject({ judge_queued: 1, judge_leased: 0, judge_scored: 0 });
    expect(onlineScores('t1')).toEqual([]);
  });

  describe('POST /observe/api/v1/evaluators/:id/test', () => {
    const appWith = (judge: JudgeFn) => {
      const agentStore = createFsAgentStore(baseDir);
      const runManager = new RunManager({
        baseDir,
        checkpointStore: new FileCheckpointStore(baseDir),
        approvalStore: new FileApprovalStore(baseDir),
        loadSpec: (id) => agentStore.load(id),
        saveSpec: (id, spec) => agentStore.save(id, spec),
      });
      return createApp({ agentStore, runManager, baseDir, judge });
    };

    it('dry-runs a judge rule on the trace with the judge and writes no score', async () => {
      const ruleId = await judgeRuleWithJob();
      const seen: unknown[] = [];
      const app = appWith(async (_rule, trace) => {
        seen.push(trace);
        return { value: 0.8, comment: 'looks right' };
      });
      const res = await request(app).post(`/observe/api/v1/evaluators/${ruleId}/test`).send({ trace_id: 't1' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ result: { value: 0.8, comment: 'looks right' } });
      expect(seen[0]).toMatchObject({ trace_id: 't1', name: 'invoke_agent refund-bot', status: 'ok' });
      expect(onlineScores('t1')).toEqual([]);
      // The dry run left the queued job alone.
      expect(daemon.evaluators.stats()).toMatchObject({ judge_queued: 1 });
    });

    it('forwards a code rule to the daemon unchanged', async () => {
      seedTrace('t1');
      const created = await fetch(`${daemonUrl}/api/v1/evaluators`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'len', kind: 'code', config: { source: '(t) => 1' } }),
      });
      const ruleId = ((await created.json()) as { evaluator: { rule_id: string } }).evaluator.rule_id;
      const app = appWith(async () => {
        throw new Error('the judge must not run for a code rule');
      });
      // The daemon's own validation answers (the body goes through as sent).
      const bad = await request(app).post(`/observe/api/v1/evaluators/${ruleId}/test`).send({ trace_id: 't1', extra: 1 });
      expect(bad.status).toBe(400);
      const missing = await request(app).post(`/observe/api/v1/evaluators/${ruleId}/test`).send({ trace_id: 'nope' });
      expect(missing.status).toBe(404);
    });

    it('passes through 404s for an unknown rule or trace, 400s a bad body, 502s a daemon that is down', async () => {
      const ruleId = await judgeRuleWithJob();
      const app = appWith(async () => ({ value: 1, comment: null }));
      const unknownRule = await request(app).post('/observe/api/v1/evaluators/nope/test').send({ trace_id: 't1' });
      expect(unknownRule.status).toBe(404);
      expect(unknownRule.body).toMatchObject({ code: 'LOUSHO_REQUEST_INVALID' });
      const unknownTrace = await request(app).post(`/observe/api/v1/evaluators/${ruleId}/test`).send({ trace_id: 'nope' });
      expect(unknownTrace.status).toBe(404);
      const badBody = await request(app).post(`/observe/api/v1/evaluators/${ruleId}/test`).send({});
      expect(badBody.status).toBe(400);
      for (const trace_id of ['.', '..', 'a/b', 'a\\b']) {
        const unsafe = await request(app).post(`/observe/api/v1/evaluators/${ruleId}/test`).send({ trace_id });
        expect(unsafe.status).toBe(400);
      }
      const encodedSlash = await request(app).post('/observe/api/v1/evaluators/a%2Fb/test').send({ trace_id: 't1' });
      expect(encodedSlash.status).toBe(400);
      process.env.LOUSHO_OBSERVE_URL = 'http://127.0.0.1:1';
      const down = await request(app).post(`/observe/api/v1/evaluators/${ruleId}/test`).send({ trace_id: 't1' });
      expect(down.status).toBe(502);
    });
  });
});

describe('parseJudgeReply', () => {
  it('reads a valid JSON reply', () => {
    expect(parseJudgeReply('{"score": 0.8, "comment": "good"}')).toEqual({ value: 0.8, comment: 'good' });
    expect(parseJudgeReply('{"score": 1}')).toEqual({ value: 1, comment: null });
  });

  it('finds the first JSON object inside prose and code fences', () => {
    expect(parseJudgeReply('Sure! Here is my grade:\n```json\n{"score": 0, "comment": "wrong {refund}"}\n```\nThanks.')).toEqual({
      value: 0,
      comment: 'wrong {refund}',
    });
    expect(parseJudgeReply('I think {this} is fine. {"score": 0.5, "comment": "ok"}')).toEqual({ value: 0.5, comment: 'ok' });
  });

  it('rejects an out-of-range or non-numeric score', () => {
    for (const reply of ['{"score": 1.5}', '{"score": -0.1}', '{"score": "0.5"}', '{"comment": "no score"}']) {
      expect(parseJudgeReply(reply)).toEqual({ value: null, comment: 'invalid_judge_output' });
    }
  });

  it('rejects garbage', () => {
    for (const reply of ['', 'no json here', '{not json', '[0.5]', '{"score": 0.5']) {
      expect(parseJudgeReply(reply)).toEqual({ value: null, comment: 'invalid_judge_output' });
    }
  });
});

describe('judgePrompt', () => {
  it('names each field and truncates long ones to ~8 KB', () => {
    const prompt = judgePrompt({
      trace_id: 't',
      agent_id: null,
      name: 'run',
      status: 'error',
      start: 0,
      end: null,
      duration_ms: null,
      input: 'x'.repeat(20_000),
      output: null,
      error_message: 'boom',
      observations: [],
    });
    expect(prompt).toContain('Name: run');
    expect(prompt).toContain('Status: error');
    expect(prompt).toContain('Output:\n(none)');
    expect(prompt).toContain('Error:\nboom');
    expect(prompt).toContain('[truncated]');
    expect(prompt.length).toBeLessThan(9000);
  });
});
