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
  };
}

function costRatio(flat: ArmSummary, product: ArmSummary): Pick<Verdict, 'costBasis' | 'costRatio'> {
  if (flat.meanCostUsd !== null && product.meanCostUsd !== null && flat.meanCostUsd > 0) return { costBasis: 'usd', costRatio: product.meanCostUsd / flat.meanCostUsd };
  if (flat.meanTokens !== null && product.meanTokens !== null && flat.meanTokens > 0) return { costBasis: 'tokens', costRatio: product.meanTokens / flat.meanTokens };
  return { costBasis: 'tokens', costRatio: null };
}

export function verdict(flat: ArmSummary | undefined, product: ArmSummary | undefined): Verdict {
  if (!flat || !product || flat.cases === 0 || flat.passK === null || product.passK === null) return { go: null, costBasis: 'tokens', costRatio: null, reason: 'Needs complete runs of both flat and product on at least one case.' };
  const cost = costRatio(flat, product);
  if (cost.costRatio === null) return { go: null, ...cost, reason: 'No cost to compare.' };
  const quality = product.passK >= flat.passK;
  const cheap = cost.costRatio <= MAX_COST_RATIO;
  const reason = `product pass^k ${product.passK.toFixed(3)} ${quality ? '>=' : '<'} flat ${flat.passK.toFixed(3)}; cost ${cost.costRatio.toFixed(2)}x flat (${cost.costBasis}) ${cheap ? '<=' : '>'} ${MAX_COST_RATIO}x`;
  return { go: quality && cheap, ...cost, reason };
}

function completeCases(rows: readonly PilotRow[], arms: readonly string[], k: number): { complete: string[]; incomplete: string[] } {
  const all = [...new Set(rows.map((row) => row.case))].sort();
  const complete = all.filter((caseId) => arms.every((arm) => scoredRuns(rows, arm, caseId).length >= k));
  return { complete, incomplete: all.filter((caseId) => !complete.includes(caseId)) };
}

export function buildReport(input: readonly PilotRow[], k = 3): Report {
  const rows = latestRows(input);
  const models = [...new Set(rows.map((row) => row.model))].sort();
  if (models.length > 1) throw new Error(`Rows mix models (${models.join(', ')}). Pass --model to pick one.`);
  const arms = [...new Set(rows.map((row) => row.arm))].sort();
  const { complete, incomplete } = completeCases(rows, arms, k);
  const summaries = arms.map((arm) => summarizeArm(rows, arm, complete, k));
  const cases = complete.map((caseId) => ({
    case: caseId,
    arms: Object.fromEntries(arms.map((arm) => {
      const scored = scoredRuns(rows, arm, caseId);
      return [arm, { passed: scored.filter((row) => row.passed).length, scored: scored.length }];
    })),
  }));
  const find = (arm: string) => summaries.find((summary) => summary.arm === arm);
  return { k, model: models, arms: summaries, cases, incomplete, verdict: verdict(find('flat'), find('product')) };
}

const show = (value: number | null, digits: number): string => (value === null ? '-' : value.toFixed(digits));

export function formatReport(report: Report): string {
  const lines = [
    `model: ${report.model.join(', ') || '-'}   cases: ${report.cases.length}   pass^${report.k}`,
    '',
    `arm         pass^${report.k}   pass rate   runs   mean tokens   mean cost USD   mean calls`,
    ...report.arms.map((arm) => `${arm.arm.padEnd(10)}  ${show(arm.passK, 3).padStart(6)}   ${show(arm.passRate, 3).padStart(9)}   ${String(arm.scored).padStart(4)}   ${show(arm.meanTokens, 0).padStart(11)}   ${show(arm.meanCostUsd, 5).padStart(13)}   ${show(arm.meanModelCalls, 1).padStart(10)}`),
    '',
    ...report.cases.map((row) => `${row.case.padEnd(20)} ${Object.entries(row.arms).map(([arm, { passed, scored }]) => `${arm} ${passed}/${scored}`).join('   ')}`),
  ];
  if (report.incomplete.length > 0) lines.push('', `incomplete, left out: ${report.incomplete.join(', ')}`);
  const decision = report.verdict.go === null ? 'NO DECISION' : report.verdict.go ? 'GO' : 'NO-GO';
  lines.push('', `${decision}: ${report.verdict.reason}`);
  return lines.join('\n');
}
