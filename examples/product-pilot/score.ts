import type { PilotRow } from './pilot';
import { rowKey } from './pilot';

const MAX_COST_RATIO = 1.3;

export interface ArmSummary {
  arm: string;
  cases: number;
  passK: number | null;
  passRate: number | null;
  scored: number;
  meanTokens: number | null;
  meanCostUsd: number | null;
  meanModelCalls: number | null;
  excluded: number;
  outOfBudget: number;
}

export interface CaseResult {
  case: string;
  arms: Record<string, { passed: number; scored: number }>;
}

export interface Verdict {
  go: boolean | null;
  costBasis: 'usd' | 'tokens';
  costRatio: number | null;
  reason: string;
}

export interface Report {
  k: number;
  model: string[];
  arms: ArmSummary[];
  cases: CaseResult[];
  incomplete: string[];
  verdict: Verdict;
  routing?: Verdict;
}

export function latestRows(rows: readonly PilotRow[]): PilotRow[] {
  const byKey = new Map<string, PilotRow>();
  for (const row of rows) if (row.passed !== null || !byKey.has(rowKey(row))) byKey.set(rowKey(row), row);
  return [...byKey.values()];
}

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 0; i < k; i++) result = (result * (n - i)) / (i + 1);
  return result;
}

export function passHatK(scored: number, passed: number, k: number): number {
  if (scored < k) throw new Error(`pass^${k} needs at least ${k} scored runs, not ${scored}.`);
  return choose(passed, k) / choose(scored, k);
}

const mean = (values: readonly number[]): number | null => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);

function scoredRuns(rows: readonly PilotRow[], arm: string, caseId: string): PilotRow[] {
  return rows.filter((row) => row.arm === arm && row.case === caseId && row.passed !== null);
}

const OUT_OF_BUDGET = new Set(['max-steps', 'budget-exceeded']);

function summarizeArm(rows: readonly PilotRow[], arm: string, cases: readonly string[], k: number): ArmSummary {
  const runs = cases.flatMap((caseId) => scoredRuns(rows, arm, caseId));
  const perCase = cases.map((caseId) => {
    const scored = scoredRuns(rows, arm, caseId);
    return passHatK(scored.length, scored.filter((row) => row.passed).length, k);
  });
  const costs = runs.map((row) => row.costUsd);
  return {
    arm,
    cases: cases.length,
    passK: mean(perCase),
    passRate: mean(runs.map((row) => (row.passed ? 1 : 0))),
    scored: runs.length,
    meanTokens: mean(runs.map((row) => row.tokens)),
    meanCostUsd: costs.every((cost) => cost !== null) ? mean(costs as number[]) : null,
    meanModelCalls: mean(runs.map((row) => row.modelCalls)),
    excluded: rows.filter((row) => row.arm === arm && row.passed === null).length,
    outOfBudget: runs.filter((row) => OUT_OF_BUDGET.has(row.ended)).length,
  };
}

function costRatio(base: ArmSummary, product: ArmSummary): Pick<Verdict, 'costBasis' | 'costRatio'> {
  if (base.meanCostUsd !== null && product.meanCostUsd !== null && base.meanCostUsd > 0) return { costBasis: 'usd', costRatio: product.meanCostUsd / base.meanCostUsd };
  if (base.meanTokens !== null && product.meanTokens !== null && base.meanTokens > 0) return { costBasis: 'tokens', costRatio: product.meanTokens / base.meanTokens };
  return { costBasis: 'tokens', costRatio: null };
}

type Scored = ArmSummary & { passK: number };

function scoredPair(base: ArmSummary | undefined, product: ArmSummary | undefined): [Scored, Scored] | undefined {
  if (!base || !product || base.cases === 0) return undefined;
  if (base.passK === null || product.passK === null) return undefined;
  return [base as Scored, product as Scored];
}

function compare(base: Scored, product: Scored, cost: { costBasis: Verdict['costBasis']; costRatio: number }): Verdict {
  const quality = product.passK >= base.passK;
  const cheap = cost.costRatio <= MAX_COST_RATIO;
  const reason = `over ${base.cases} cases, product pass^k ${product.passK.toFixed(3)} ${quality ? '>=' : '<'} ${base.arm} ${base.passK.toFixed(3)}; cost ${cost.costRatio.toFixed(2)}x ${base.arm} (${cost.costBasis}) ${cheap ? '<=' : '>'} ${MAX_COST_RATIO}x`;
  return { go: quality && cheap, ...cost, reason };
}

export function verdict(base: ArmSummary | undefined, product: ArmSummary | undefined): Verdict {
  const pair = scoredPair(base, product);
  if (!pair) return { go: null, costBasis: 'tokens', costRatio: null, reason: `Needs complete runs of both ${base?.arm ?? 'the baseline'} and product on at least one case.` };
  const cost = costRatio(pair[0], pair[1]);
  if (cost.costRatio === null) return { go: null, ...cost, reason: 'No cost to compare.' };
  return compare(pair[0], pair[1], { costBasis: cost.costBasis, costRatio: cost.costRatio });
}

function completeCases(rows: readonly PilotRow[], arms: readonly string[], k: number): { complete: string[]; incomplete: string[] } {
  const all = [...new Set(rows.map((row) => row.case))].sort();
  const complete = all.filter((caseId) => arms.every((arm) => scoredRuns(rows, arm, caseId).length >= k));
  return { complete, incomplete: all.filter((caseId) => !complete.includes(caseId)) };
}

function pairVerdict(rows: readonly PilotRow[], base: string, k: number): Verdict {
  const { complete } = completeCases(rows, [base, 'product'], k);
  return verdict(complete.length > 0 ? summarizeArm(rows, base, complete, k) : undefined, summarizeArm(rows, 'product', complete, k));
}

function single(rows: readonly PilotRow[], field: 'model' | 'budget'): string[] {
  const values = [...new Set(rows.map((row) => row[field]))].sort();
  if (values.length > 1) throw new Error(`Rows mix ${field}s (${values.join('; ')}). Pick one${field === 'model' ? ' with --model' : ''}.`);
  return values;
}

export function buildReport(input: readonly PilotRow[], k = 3): Report {
  const rows = latestRows(input);
  const models = single(rows, 'model');
  single(rows, 'budget');
  const arms = [...new Set(rows.map((row) => row.arm))].sort();
  const { complete, incomplete } = completeCases(rows, arms, k);
  const cases = complete.map((caseId) => ({
    case: caseId,
    arms: Object.fromEntries(
      arms.map((arm) => {
        const scored = scoredRuns(rows, arm, caseId);
        return [arm, { passed: scored.filter((row) => row.passed).length, scored: scored.length }];
      })
    ),
  }));
  const report: Report = { k, model: models, arms: arms.map((arm) => summarizeArm(rows, arm, complete, k)), cases, incomplete, verdict: pairVerdict(rows, 'flat', k) };
  if (arms.includes('flat-plus')) report.routing = pairVerdict(rows, 'flat-plus', k);
  return report;
}

const show = (value: number | null, digits: number): string => (value === null ? '-' : value.toFixed(digits));

const decision = (v: Verdict): string => (v.go === null ? 'NO DECISION' : v.go ? 'GO' : 'NO-GO');

function armLine(arm: ArmSummary): string {
  return `${arm.arm.padEnd(10)}  ${show(arm.passK, 3).padStart(6)}   ${show(arm.passRate, 3).padStart(9)}   ${String(arm.scored).padStart(4)}   ${String(arm.excluded).padStart(8)}   ${String(arm.outOfBudget).padStart(13)}   ${show(arm.meanTokens, 0).padStart(11)}   ${show(arm.meanCostUsd, 5).padStart(13)}   ${show(arm.meanModelCalls, 1).padStart(10)}`;
}

export function formatReport(report: Report): string {
  const lines = [
    `model: ${report.model.join(', ') || '-'}   cases complete in every arm: ${report.cases.length}   pass^${report.k}`,
    '',
    `arm         pass^${report.k}   pass rate   runs   excluded   out of budget   mean tokens   mean cost USD   mean calls`,
    ...report.arms.map(armLine),
    '',
    ...report.cases.map((row) => `${row.case.padEnd(20)} ${Object.entries(row.arms).map(([arm, { passed, scored }]) => `${arm} ${passed}/${scored}`).join('   ')}`),
  ];
  if (report.incomplete.length > 0) lines.push('', `incomplete in some arm: ${report.incomplete.join(', ')}`);
  lines.push('', `${decision(report.verdict)}: ${report.verdict.reason}`);
  if (report.routing) lines.push(`routing check vs flat-plus, ${decision(report.routing)}: ${report.routing.reason}`);
  return lines.join('\n');
}
