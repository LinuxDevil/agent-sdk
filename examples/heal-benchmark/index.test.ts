import { describe, expect, it } from 'vitest';
import { mockModel } from 'lousho/testing';
import { AGENTS } from './agents';
import { harnessVersion, runBenchmark, type BenchmarkRun } from './run';
import { formatSummary, summarize } from './score';

const run = (over: Partial<BenchmarkRun> = {}): BenchmarkRun => ({
  harness: 'h1',
  agent: 'doc-qa',
  task: 't1',
  taskInput: 'i1',
  model: 'm',
  repeat: 0,
  outcome: 'passed',
  ended: 'stop',
  toolRuns: 2,
  tokens: 100,
  ...over,
});

describe('summarize', () => {
  it('reports pass rate, cost and the spread between repeats, per harness', () => {
    const [summary] = summarize([
      run({ repeat: 0 }),
      run({ repeat: 0, task: 't2', outcome: 'failed', tokens: 300 }),
      run({ repeat: 1 }),
      run({ repeat: 1, task: 't2' }),
    ]);
    expect(summary).toMatchObject({ harness: 'h1', runs: 4, scored: 4, excluded: 0, passed: 3, passRate: 0.75, tokensPerRun: 150 });
    expect(summary.noise).toBeCloseTo(0.25);
  });

  it('excludes unknown outcomes from the score instead of counting them as failures', () => {
    const [summary] = summarize([run(), run({ repeat: 1, outcome: 'unknown', tokens: 0 })]);
    expect(summary).toMatchObject({ runs: 2, scored: 1, excluded: 1, passRate: 1 });
  });

  it('counts real failures, so a harness that always fails scores zero', () => {
    const [summary] = summarize([run({ outcome: 'failed' }), run({ repeat: 1, outcome: 'failed' })]);
    expect(summary.passRate).toBe(0);
  });

  it('has no score when nothing could be scored', () => {
    const [summary] = summarize([run({ outcome: 'unknown' })]);
    expect(summary.passRate).toBeNull();
  });

  it('keeps harness versions apart, and breaks results down by task', () => {
    const summaries = summarize([run({ harness: 'a' }), run({ harness: 'b', outcome: 'failed' })]);
    expect(summaries.map((s) => [s.harness, s.passRate])).toEqual([
      ['a', 1],
      ['b', 0],
    ]);
    expect(summaries[0].tasks).toEqual([{ agent: 'doc-qa', task: 't1', passed: 1, scored: 1 }]);
  });

  it('refuses to mix results for a task whose input changed', () => {
    expect(() => summarize([run({ taskInput: 'old' }), run({ repeat: 1, taskInput: 'new' })])).toThrow(/doc-qa\/t1.*changed/);
  });

  it('prints a scoreboard that shows exclusions', () => {
    const text = formatSummary(summarize([run(), run({ repeat: 1, outcome: 'unknown' })]));
    expect(text).toContain('100%');
    expect(text).toContain('1 excluded');
  });
});

describe('harnessVersion', () => {
  const agent = AGENTS[0]();

  it('is stable for the same harness', () => {
    expect(harnessVersion(agent)).toBe(harnessVersion(AGENTS[0]()));
  });

  it('changes when the instructions or the hooks change', () => {
    const base = harnessVersion(agent);
    expect(harnessVersion({ ...agent, instructions: `${agent.instructions} More.` })).not.toBe(base);
    expect(harnessVersion(agent, ['progress-guard'])).not.toBe(base);
  });

  it('changes when a tool changes', () => {
    const [first, ...rest] = agent.tools;
    expect(harnessVersion({ ...agent, tools: rest })).not.toBe(harnessVersion({ ...agent, tools: [first, ...rest] }));
  });
});

describe('agents', () => {
  it('have answer keys that match their data', () => {
    const owed = 1250 + 980.5 + 2300 + 410.25 + 75 + 1120 - (1250 + 2000 + 410.25 + 1120);
    expect(owed).toBe(1355.5);
    expect(15 * 70000 + 7 * 50000 + 26 * 120000).toBe(4_520_000);
    expect((200 - 15) * 0.85).toBe(157.25);
    expect(1000 + 800 * 1.1 + 200 * 1.25).toBe(2130);
    const task = (agent: number, id: string) => AGENTS[agent]().tasks.find((t) => t.id === id);
    expect(task(1, 'reconcile')?.check('You are owed $1,355.50 in total.')).toBe(true);
    expect(task(1, 'cost-growth')?.check('$4,520,000, excluding Ops, which has no salary data.')).toBe(true);
    expect(task(2, 'pro-rata')?.check('You get 15 days.')).toBe(true);
    expect(task(2, 'contractor-meals')?.check('Your limit is $40 per day.')).toBe(true);
    expect(task(1, 'fx-total')?.check('The total is $2,130.')).toBe(true);
    expect(task(1, 'unique-signups')?.check('4 different people.')).toBe(true);
    expect(task(1, 'unique-signups')?.check('**4 different people**. The file has 6 email entries.')).toBe(true);
    expect(task(1, 'unique-signups')?.check('**6 different** people, or 4 if you ignore case.')).toBe(false);
    expect(task(1, 'unique-signups')?.check('There are 6 people.')).toBe(false);
    expect(task(0, 'partial-refund')?.input).toMatch(/unopened/i);
    expect(task(2, 'stale-doc')?.check('The limit is $75 per day.')).toBe(true);
  });

  it('have unique task ids, and every check rejects an empty answer', () => {
    for (const build of AGENTS) {
      const agent = build();
      const ids = agent.tasks.map((task) => task.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const task of agent.tasks) expect(task.check('')).toBe(false);
    }
  });
});

describe('runBenchmark', () => {
  const scripted = () => mockModel(['I cannot answer.']);

  it('runs each task per model and repeat, and scores it with its check', async () => {
    const rows = await runBenchmark({ agents: [AGENTS[2]], models: ['a', 'b'], repeats: 2, provider: scripted });
    expect(rows).toHaveLength(AGENTS[2]().tasks.length * 4);
    expect(rows.every((row) => row.outcome === 'passed' || row.outcome === 'failed')).toBe(true);
    expect(new Set(rows.map((row) => row.harness)).size).toBe(1);
  });

  it('marks a provider failure unknown, not failed', async () => {
    const failing = () => ({
      ...mockModel(['x']),
      generate: async () => {
        throw Object.assign(new Error('Rate limit exceeded'), { statusCode: 429 });
      },
    });
    const rows = await runBenchmark({ agents: [AGENTS[2]], models: ['a'], repeats: 1, provider: failing, retry: false });
    expect(rows.every((row) => row.outcome === 'unknown')).toBe(true);
  });

  it('applies an instruction edit, and the version shows it', async () => {
    const seen: string[] = [];
    const rows = await runBenchmark({
      agents: [AGENTS[2]],
      models: ['a'],
      repeats: 1,
      provider: scripted,
      only: 'forbidden-doc',
      instructionSuffix: ' Stop when forbidden.',
      onRun: (row) => seen.push(row.harness),
    });
    const base = await runBenchmark({ agents: [AGENTS[2]], models: ['a'], repeats: 1, provider: scripted, only: 'forbidden-doc' });
    expect(rows).toHaveLength(1);
    expect(seen).toEqual([rows[0].harness]);
    expect(rows[0].harness).not.toBe(base[0].harness);
  });

  it('reports how a run ended', async () => {
    const [row] = await runBenchmark({ agents: [AGENTS[2]], models: ['a'], repeats: 1, provider: scripted, only: 'forbidden-doc' });
    expect(row).toMatchObject({ agent: 'doc-qa', task: 'forbidden-doc', ended: 'stop', toolRuns: 0 });
  });
});
