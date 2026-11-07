import type { LabelledRun } from './evidence';
import type { CaseCount, CaseVerdict, ImproveResult, ProbeSummary } from './types';

export type CostComparison = NonNullable<ImproveResult['costOnPassingCases']>;

export const MIN_CASE_GAIN = 2 / 3;

export interface JudgedCase {
  verdict: CaseVerdict;
  scorable: boolean;
  improved: boolean;
  dropped: boolean;
}

const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

function spread(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const middle = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - middle) ** 2, 0) / values.length);
}

export function summarize(runs: readonly LabelledRun[]): ProbeSummary {
  const scored = runs.filter(({ run }) => run.passed !== null);
  const passed = scored.filter(({ run }) => run.passed).length;
  const repeats = [...new Set(scored.map(({ repeat }) => repeat))].map((repeat) => {
    const own = scored.filter((entry) => entry.repeat === repeat);
    return own.filter(({ run }) => run.passed).length / own.length;
  });
  return {
    runs: runs.length,
    excluded: runs.length - scored.length,
    passRate: scored.length === 0 ? null : passed / scored.length,
    noise: spread(repeats),
    tokensPerRun: runs.length === 0 ? 0 : runs.reduce((sum, { run }) => sum + run.tokens, 0) / runs.length,
  };
}

const passingTokens = (runs: readonly LabelledRun[], caseId: string) => runs.filter((entry) => entry.caseId === caseId && entry.run.passed).map((entry) => entry.run.tokens);

export function costOnPassingCases(before: readonly LabelledRun[], after: readonly LabelledRun[]): CostComparison | undefined {
  const pairs = [...new Set(before.map(({ caseId }) => caseId))].flatMap((caseId) => {
    const base = passingTokens(before, caseId);
    const final = passingTokens(after, caseId);
    if (base.length === 0 || final.length === 0) return [];
    return [{ base: mean(base), final: mean(final), noise: Math.max(spread(base), spread(final)) }];
  });
  if (pairs.length === 0) return undefined;
  return { cases: pairs.length, base: mean(pairs.map((pair) => pair.base)), final: mean(pairs.map((pair) => pair.final)), noise: mean(pairs.map((pair) => pair.noise)) };
}

function costFailure(cost: CostComparison, maxCostIncrease: number): string | undefined {
  const rise = cost.final - cost.base;
  if (cost.base <= 0 || rise <= cost.base * maxCostIncrease || rise <= cost.noise) return undefined;
  return `The edit raised cost per passing run by more than ${Math.round(maxCostIncrease * 100)}% and more than noise (${Math.round(cost.base)} to ${Math.round(cost.final)} tokens, noise ${Math.round(cost.noise)}).`;
}

export function caseCount(runs: readonly LabelledRun[], caseId: string): CaseCount {
  const scored = runs.filter((entry) => entry.caseId === caseId && entry.run.passed !== null);
  return { passed: scored.filter((entry) => entry.run.passed).length, scored: scored.length };
}

const rate = (count: CaseCount) => count.passed / count.scored;
const ratio = (count: CaseCount) => `${count.passed}/${count.scored}`;

type Judgement = Pick<JudgedCase, 'scorable' | 'improved' | 'dropped'> & { reason: string };

function judgeScored(base: CaseCount, final: CaseCount): Judgement {
  const gain = rate(final) - rate(base);
  const from = `${ratio(base)} to ${ratio(final)}`;
  if (gain >= MIN_CASE_GAIN - 1e-9) return { scorable: true, improved: true, dropped: false, reason: `Improved from ${from}.` };
  if (gain < 0) return { scorable: true, improved: false, dropped: true, reason: `Got worse, from ${from}.` };
  if (base.passed === 0 && final.passed === 0) return { scorable: true, improved: false, dropped: false, reason: 'Failed under both harnesses.' };
  return { scorable: true, improved: false, dropped: false, reason: `Changed from ${from}, less than the 2-in-3 gain the gate needs.` };
}

export function judgeTrainingCase(caseId: string, base: CaseCount, final: CaseCount): JudgedCase {
  const unscored = base.scored === 0 || final.scored === 0;
  const { reason, ...judgement } = unscored
    ? { scorable: false, improved: false, dropped: false, reason: 'Could not be scored under both harnesses, so it was left out.' }
    : judgeScored(base, final);
  return { verdict: { caseId, role: 'training', base, final, reasons: [reason] }, ...judgement };
}

export function trainingFailure(cases: readonly JudgedCase[]): string | undefined {
  if (!cases.some((judged) => judged.scorable)) return 'The edit could not be scored.';
  const dropped = cases.filter((judged) => judged.dropped).map((judged) => judged.verdict.caseId);
  if (dropped.length > 0) return `A training case got worse (${dropped.join(', ')}).`;
  if (!cases.some((judged) => judged.improved)) return 'No training case improved by at least 2 in 3 runs.';
  return undefined;
}

function holdoutFailure(holdout: { base: ProbeSummary; final: ProbeSummary } | undefined): string | undefined {
  if (!holdout || holdout.base.passRate === null || holdout.final.passRate === null) return undefined;
  if (holdout.final.passRate >= holdout.base.passRate) return undefined;
  return `A held-out case got worse (${holdout.base.passRate.toFixed(2)} to ${holdout.final.passRate.toFixed(2)}).`;
}

export function gateFailure(input: {
  training: readonly JudgedCase[];
  holdout?: { base: ProbeSummary; final: ProbeSummary };
  cost?: CostComparison;
  maxCostIncrease: number;
}): string | undefined {
  return trainingFailure(input.training) ?? holdoutFailure(input.holdout) ?? (input.cost && costFailure(input.cost, input.maxCostIncrease));
}
