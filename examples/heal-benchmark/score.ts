import type { BenchmarkRun } from './run';

export interface TaskScore {
  agent: string;
  task: string;
  passed: number;
  scored: number;
}

export interface HarnessSummary {
  harness: string;
  runs: number;
  scored: number;
  excluded: number;
  passed: number;
  passRate: number | null;
  noise: number;
  tokensPerRun: number;
  toolRunsPerRun: number;
  tasks: TaskScore[];
}

function assertSameInputs(runs: readonly BenchmarkRun[]): void {
  const inputs = new Map<string, string>();
  for (const run of runs) {
    const key = `${run.agent}/${run.task}`;
    const seen = inputs.get(key);
    if (seen !== undefined && seen !== run.taskInput) throw new Error(`Task ${key} changed between runs, so its results can't be compared.`);
    inputs.set(key, run.taskInput);
  }
}

function spread(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

function repeatRates(scored: readonly BenchmarkRun[]): number[] {
  const byRepeat = new Map<number, BenchmarkRun[]>();
  for (const run of scored) byRepeat.set(run.repeat, [...(byRepeat.get(run.repeat) ?? []), run]);
  return [...byRepeat.values()].map((runs) => runs.filter((run) => run.outcome === 'passed').length / runs.length);
}

function taskScores(scored: readonly BenchmarkRun[]): TaskScore[] {
  const tasks = new Map<string, TaskScore>();
  for (const run of scored) {
    const key = `${run.agent}/${run.task}`;
    const score = tasks.get(key) ?? { agent: run.agent, task: run.task, passed: 0, scored: 0 };
    score.scored += 1;
    if (run.outcome === 'passed') score.passed += 1;
    tasks.set(key, score);
  }
  return [...tasks.values()];
}

function summarizeHarness(harness: string, runs: readonly BenchmarkRun[]): HarnessSummary {
  const scored = runs.filter((run) => run.outcome !== 'unknown');
  const passed = scored.filter((run) => run.outcome === 'passed').length;
  const average = (pick: (run: BenchmarkRun) => number) => (scored.length === 0 ? 0 : scored.reduce((sum, run) => sum + pick(run), 0) / scored.length);
  return {
    harness,
    runs: runs.length,
    scored: scored.length,
    excluded: runs.length - scored.length,
    passed,
    passRate: scored.length === 0 ? null : passed / scored.length,
    noise: spread(repeatRates(scored)),
    tokensPerRun: average((run) => run.tokens),
    toolRunsPerRun: average((run) => run.toolRuns),
    tasks: taskScores(scored),
  };
}

export function summarize(runs: readonly BenchmarkRun[]): HarnessSummary[] {
  assertSameInputs(runs);
  const harnesses = [...new Set(runs.map((run) => run.harness))];
  return harnesses.map((harness) => summarizeHarness(harness, runs.filter((run) => run.harness === harness)));
}

const percent = (rate: number | null) => (rate === null ? 'no score' : `${Math.round(rate * 100)}%`);

export function formatSummary(summaries: readonly HarnessSummary[]): string {
  return summaries
    .map((summary) => {
      const head = `${summary.harness}  ${percent(summary.passRate)} passed (${summary.passed}/${summary.scored}), noise ±${Math.round(summary.noise * 100)} points, ${Math.round(summary.tokensPerRun)} tokens/run, ${summary.excluded} excluded`;
      const tasks = summary.tasks.map((task) => `  ${task.agent}/${task.task}: ${task.passed}/${task.scored}`);
      return [head, ...tasks].join('\n');
    })
    .join('\n\n');
}
