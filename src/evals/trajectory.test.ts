import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockTurn } from '../testing';
import { atLeast, atMost, equals, includes, matches } from './checks';
import { defineEval } from './defineEval';
import { describeFailure, runTrajectoryCase, type EvalTestContext } from './trajectory';
import type { EvalResult } from './evalResult';
import { matchesTagFilter, recordEvalResult, RESULTS_ENV, TAGS_ENV } from './recorder';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const lookupOrder = defineTool({
  name: 'lookup_order',
  description: 'Look up an order',
  input: z.object({ orderId: z.string() }),
  execute: ({ orderId }) => ({ orderId, status: 'shipped' }),
});
const checkPolicy = defineTool({
  name: 'check_policy',
  description: 'Check the refund policy',
  input: z.object({}),
  execute: () => ({ days: 30 }),
});
const issueRefund = defineTool({
  name: 'issue_refund',
  description: 'Refund an order',
  input: z.object({ orderId: z.string() }),
  execute: () => ({ ok: true }),
});

const REFUND_SCRIPT: MockTurn[] = [
  { toolCalls: [{ name: 'lookup_order', args: { orderId: '42', verbose: true } }], usage: { inputTokens: 10, outputTokens: 5 } },
  { toolCalls: [{ name: 'check_policy' }], usage: { inputTokens: 10, outputTokens: 5 } },
  { text: 'You can return it within 30 days.', usage: { inputTokens: 10, outputTokens: 5 } },
];

function refundAgent(script: MockTurn[] = REFUND_SCRIPT, maxSteps?: number) {
  return createAgent({
    prompt: 'You handle refunds.',
    provider: mockModel(script),
    tools: [lookupOrder, checkPolicy, issueRefund],
    maxSteps,
  });
}

async function run(
  test: (t: EvalTestContext) => void | Promise<void>,
  options: { agent?: ReturnType<typeof refundAgent>; judge?: Parameters<typeof runTrajectoryCase>[0]['judge'] } = {}
): Promise<EvalResult> {
  const spec = { name: 'refund', agent: options.agent ?? refundAgent(), judge: options.judge, test };
  return runTrajectoryCase(spec, {}, undefined, undefined);
}

function failedMessages(result: EvalResult): string[] {
  return result.assertions.filter((a) => !a.passed).map((a) => a.message ?? '');
}

describe('trajectory assertions: passing', () => {
  it('passes every assertion for a matching run and reports steps, tool calls and usage', async () => {
    const result = await run(async (t) => {
      await t.send('Refund order 42');
      t.completed();
      t.calledTool('lookup_order');
      t.calledTool('lookup_order', { args: { orderId: '42' }, times: 1 });
      t.notCalledTool('issue_refund');
      t.toolOrder(['lookup_order', 'check_policy']);
      t.check('mentions policy', t.reply, includes('30 days'));
      t.maxSteps(3);
      t.maxTokens(100);
    });
    expect(result.passed).toBe(true);
    expect(failedMessages(result)).toEqual([]);
    expect(result.steps).toBe(3);
    expect(result.toolCalls.map((c) => c.name)).toEqual(['lookup_order', 'check_policy']);
    expect(result.usage?.totalTokens).toBe(45);
    expect(result.assertions.map((a) => a.name)).toContain("calledTool('lookup_order', {\"args\":{\"orderId\":\"42\"},\"times\":1})");
  });

  it('accepts a subsequence for toolOrder with other calls in between', async () => {
    const result = await run(async (t) => {
      await t.send('go');
      t.toolOrder(['lookup_order', 'check_policy']);
      t.toolOrder(['check_policy']);
      t.toolOrder([]);
    });
    expect(result.passed).toBe(true);
  });
});

describe('trajectory assertions: diagnostic failures', () => {
  it('completed() explains a run that was cut off by maxSteps', async () => {
    const result = await run(
      async (t) => {
        await t.send('go');
        t.completed();
      },
      { agent: refundAgent(REFUND_SCRIPT, 1) }
    );
    expect(result.passed).toBe(false);
    expect(failedMessages(result)).toEqual([
      "completed() failed: finishReason was 'tool_calls' (the run hit maxSteps while still calling tools)",
    ]);
  });

  it('completed() before any send() says to call t.send() first', async () => {
    const result = await run((t) => t.completed());
    expect(failedMessages(result)).toEqual(['completed() failed: no run yet - call t.send() first']);
  });

  it('calledTool() lists the tools that were called', async () => {
    const result = await run(async (t) => {
      await t.send('go');
      t.calledTool('issue_refund');
    });
    expect(failedMessages(result)).toEqual([
      "calledTool('issue_refund') failed: tools called were [lookup_order, check_policy]",
    ]);
  });

  it('calledTool() says "none" when nothing was called', async () => {
    const agent = refundAgent(['Hello']);
    const result = await run(async (t) => {
      await t.send('go');
      t.calledTool('lookup_order');
    }, { agent });
    expect(failedMessages(result)).toEqual(["calledTool('lookup_order') failed: tools called were none"]);
  });

  it('calledTool() shows the argument diff of the closest call', async () => {
    const result = await run(async (t) => {
      await t.send('go');
      t.calledTool('lookup_order', { args: { orderId: '41', verbose: true } });
    });
    expect(failedMessages(result)).toEqual([
      "calledTool('lookup_order', {\"args\":{\"orderId\":\"41\",\"verbose\":true}}) failed: 'lookup_order' was called 1 time(s) but no call matched the expected args; closest call differs in orderId: expected \"41\", got \"42\"",
    ]);
  });

  it('calledTool() reports missing argument keys', async () => {
    const result = await run(async (t) => {
      await t.send('go');
      t.calledTool('lookup_order', { args: { reason: 'damaged' } });
    });
    expect(failedMessages(result)[0]).toContain('reason: expected "damaged", got undefined');
  });

  it('calledTool() reports a wrong call count', async () => {
    const result = await run(async (t) => {
      await t.send('go');
      t.calledTool('lookup_order', { times: 2 });
    });
    expect(failedMessages(result)).toEqual([
      "calledTool('lookup_order', {\"times\":2}) failed: 'lookup_order' was called 1 time(s), expected 2",
    ]);
  });

  it('notCalledTool() says how often the tool was called', async () => {
    const result = await run(async (t) => {
      await t.send('go');
      t.notCalledTool('check_policy');
    });
    expect(failedMessages(result)).toEqual([
      "notCalledTool('check_policy') failed: 'check_policy' was called 1 time(s); tools called were [lookup_order, check_policy]",
    ]);
  });

  it('toolOrder() shows the actual order', async () => {
    const result = await run(async (t) => {
      await t.send('go');
      t.toolOrder(['check_policy', 'lookup_order']);
    });
    expect(failedMessages(result)).toEqual([
      'toolOrder([check_policy, lookup_order]) failed: tools called were [lookup_order, check_policy]',
    ]);
  });

  it('check() names the failed score and quotes the value', async () => {
    const result = await run(async (t) => {
      await t.send('go');
      t.check('mentions refund', t.reply, includes('refund'));
    });
    expect(failedMessages(result)).toEqual([
      "check 'mentions refund' failed: expected \"You can return it within 30 days.\" to include \"refund\"",
    ]);
  });

  it('maxSteps(), maxTokens() report the measured values', async () => {
    const result = await run(async (t) => {
      await t.send('go');
      t.maxSteps(2);
      t.maxTokens(10);
    });
    expect(failedMessages(result)).toEqual([
      'maxSteps(2) failed: the agent took 3 steps',
      'maxTokens(10) failed: the agent used 45 tokens',
    ]);
  });

  it('maxCostUsd() is skipped (and counts as passed) when the run reports no cost', async () => {
    const result = await run(async (t) => {
      await t.send('go');
      t.maxCostUsd(0.01);
    });
    expect(result.passed).toBe(true);
    expect(result.assertions[0]).toMatchObject({ name: 'maxCostUsd(0.01)', passed: true, skipped: true });
    expect(result.assertions[0].message).toContain('no cost');
  });

  it('maxCostUsd() enforces the limit when usage.costUsd is reported', async () => {
    const costly = {
      send: async () => ({
        text: 'ok',
        messages: [],
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0.5 },
        finishReason: 'stop',
        steps: 1,
      }),
    };
    const result = await run(
      async (t) => {
        await t.send('go');
        t.maxCostUsd(0.1);
        t.maxCostUsd(1);
      },
      { agent: costly as unknown as ReturnType<typeof refundAgent> }
    );
    expect(failedMessages(result)).toEqual(['maxCostUsd(0.1) failed: the agent cost $0.5']);
  });
});

describe('checks', () => {
  it('score and explain pass and fail', () => {
    expect(includes('a').evaluate('cat')).toMatchObject({ passed: true, score: 1 });
    expect(matches(/\d+/g).evaluate('order 42')).toMatchObject({ passed: true });
    expect(matches(/\d+/g).evaluate('order 42')).toMatchObject({ passed: true }); // global flag must not be stateful
    expect(matches(/\d+/).evaluate('none').message).toBe('expected "none" to match /\\d+/');
    expect(equals({ a: 1 }).evaluate({ a: 1 }).passed).toBe(true);
    expect(equals({ a: 1 }).evaluate({ a: 2 }).message).toBe('expected {"a":2} to equal {"a":1}');
    expect(atLeast(0.7).evaluate(0.8)).toEqual({ score: 0.8, passed: true, threshold: 0.7, message: undefined });
    expect(atLeast(0.7).evaluate(0.5).message).toBe('score 0.5 is below the threshold 0.7');
    expect(atMost(10).evaluate(11).message).toBe('value 11 is above the limit 10');
    expect(atMost(10).evaluate(10).passed).toBe(true);
  });

  it('truncates long values in messages', () => {
    const message = includes('x').evaluate('a'.repeat(300)).message ?? '';
    expect(message).toContain('...');
    expect(message.length).toBeLessThan(250);
  });
});

describe('soft vs gate', () => {
  it('a failed soft assertion is recorded with its score but does not fail the case', async () => {
    const result = await run(async (t) => {
      await t.send('go');
      t.soft('tone', 0.4, atLeast(0.7));
      t.soft('polite', t.reply, includes('please'));
    });
    expect(result.passed).toBe(true);
    expect(result.assertions).toEqual([
      { name: 'tone', kind: 'soft', passed: false, score: 0.4, threshold: 0.7, message: "soft check 'tone' failed: score 0.4 is below the threshold 0.7" },
      expect.objectContaining({ name: 'polite', kind: 'soft', passed: false, score: 0 }),
    ]);
  });

  it('a failed gate assertion fails the case, and every gate failure is listed', async () => {
    const result = await run(async (t) => {
      await t.send('go');
      t.check('first', 1, atLeast(2));
      t.check('second', 'x', equals('y'));
      t.soft('ignored', 0, atLeast(1));
    });
    expect(result.passed).toBe(false);
    expect(describeFailure(result)).toBe(
      [
        'refund failed:',
        "  - check 'first' failed: score 1 is below the threshold 2",
        "  - check 'second' failed: expected \"x\" to equal \"y\"",
      ].join('\n')
    );
  });
});

describe('errors', () => {
  it('records an error thrown by the test body instead of throwing', async () => {
    const result = await run(async (t) => {
      await t.send('go');
      throw new Error('boom');
    });
    expect(result.passed).toBe(false);
    expect(result.error).toBe('boom');
    expect(describeFailure(result)).toContain('  - boom');
  });

  it('records a failing factory as an error', async () => {
    const result = await runTrajectoryCase(
      {
        name: 'x',
        agent: () => {
          throw new Error('no agent today');
        },
        test: (t) => t.send('go').then(() => undefined),
      },
      {},
      'a case',
      'file.eval.ts'
    );
    expect(result).toMatchObject({ passed: false, error: 'no agent today', case: 'a case', file: 'file.eval.ts' });
    expect(describeFailure(result)).toContain('x [a case] failed:');
  });

  it('t.judge() without a judge provider throws a clear error and never calls an LLM', async () => {
    const result = await run(async (t) => {
      await t.send('go');
      await t.judge('Is it polite?');
    });
    expect(result.passed).toBe(false);
    expect(result.error).toContain('t.judge() needs a judge provider');
    expect(result.error).toContain('judge: { provider, model }');
    expect(result.error).toContain('*.judge.eval.ts');
  });

  it('t.judge() needs a run first', async () => {
    const judge = { provider: mockModel(['1']), model: 'm' };
    const result = await run((t) => t.judge('x').then(() => undefined), { judge });
    expect(result.error).toBe('t.judge() grades the latest reply - call t.send() first.');
  });
});

describe('t.judge() with an explicit judge provider', () => {
  it('grades the latest reply even outside the judge runner, using the mock judge', async () => {
    const judgeModel = mockModel(['0.9']);
    const result = await run(
      async (t) => {
        await t.send('go');
        t.soft('tone', await t.judge('Is the reply polite?'), atLeast(0.7));
      },
      { judge: { provider: judgeModel, model: 'judge-model' } }
    );
    expect(result.passed).toBe(true);
    expect(result.assertions[0]).toMatchObject({ name: 'tone', kind: 'soft', passed: true, score: 0.9 });
    const prompt = judgeModel.calls[0].messages[0].content;
    expect(prompt).toContain('Is the reply polite?');
    expect(prompt).toContain('You can return it within 30 days.');
  });
});

describe('agent factory isolation', () => {
  it('builds a fresh agent per case when given a factory', async () => {
    const built: number[] = [];
    const spec = {
      name: 'factory',
      agent: () => {
        built.push(built.length);
        return createAgent({ provider: mockModel(['hello']) });
      },
      test: async (t: EvalTestContext) => {
        await t.send('hi');
        t.check('reply', t.reply, equals('hello'));
      },
    };
    const results = [
      await runTrajectoryCase(spec, {}, 'one', undefined),
      await runTrajectoryCase(spec, {}, 'two', undefined),
    ];
    expect(built).toEqual([0, 1]);
    expect(results.map((r) => r.passed)).toEqual([true, true]);
  });

  it('a shared agent instance would run out of scripted turns on the second case (why factories exist)', async () => {
    const shared = createAgent({ provider: mockModel(['hello']) });
    const spec = { name: 'shared', agent: shared, test: (t: EvalTestContext) => t.send('hi').then(() => undefined) };
    expect((await runTrajectoryCase(spec, {}, 'one', undefined)).passed).toBe(true);
    const second = await runTrajectoryCase(spec, {}, 'two', undefined);
    expect(second.passed).toBe(false);
    expect(second.error).toContain('the script only has 1 turn');
  });
});

describe('recorder', () => {
  const sample: EvalResult = {
    name: 'e',
    tags: ['smoke'],
    passed: true,
    assertions: [],
    durationMs: 1,
    steps: 1,
    toolCalls: [],
  };

  it('appends one JSON line per result when LOUSHY_EVAL_RESULTS is set, and nothing otherwise', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'loushy-rec-')), 'r.jsonl');
    recordEvalResult(sample);
    expect(fs.existsSync(file)).toBe(false);
    process.env[RESULTS_ENV] = file;
    try {
      recordEvalResult(sample);
      recordEvalResult({ ...sample, name: 'f' });
    } finally {
      delete process.env[RESULTS_ENV];
    }
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines.map((l) => (JSON.parse(l) as EvalResult).name)).toEqual(['e', 'f']);
  });

  it('filters by tag', () => {
    expect(matchesTagFilter([])).toBe(true);
    process.env[TAGS_ENV] = 'smoke, nightly';
    try {
      expect(matchesTagFilter(['smoke'])).toBe(true);
      expect(matchesTagFilter(['other'])).toBe(false);
      expect(matchesTagFilter([])).toBe(false);
    } finally {
      delete process.env[TAGS_ENV];
    }
  });
});

// --- real defineEval() registrations: datasets, labels, classic form unchanged -----------------

const seen: string[] = [];

defineEval({
  name: 'dataset eval',
  agent: () => createAgent({ provider: mockModel([(req) => `echo ${String(req.messages.at(-1)?.content)}`]) }),
  cases: [
    { input: 'alpha', expect: 'echo alpha' },
    { input: 'beta', label: 'the beta case', expect: 'echo beta' },
  ],
  async test(t, c) {
    seen.push(c.input);
    await t.send(c.input);
    t.completed();
    t.check('echoes', t.reply, equals(c.expect));
  },
});

defineEval({
  name: 'no cases',
  agent: createAgent({ provider: mockModel(['fine']) }),
  async test(t) {
    await t.send('x');
    t.check('reply', t.reply, includes('fine'));
  },
});

describe('defineEval dataset registration', () => {
  it('ran the test once per case, in order', () => {
    expect(seen).toEqual(['alpha', 'beta']);
  });
});
