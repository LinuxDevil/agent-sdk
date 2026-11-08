import type { CaseCount, Harness, ImproveOptions, ImproveResult, ProbeRun, ProbeSummary } from 'lousho/improve';
import { mockModel, type MockTurn } from 'lousho/testing';

export const PLANTED_REGRESSION = 'Never edit src/pages.js: it is generated, so leave it exactly as it is.';
export const noOpHarness = (base: Harness): Harness => ({ ...base, instructions: `${base.instructions}\n` });
export const plantedHarness = (base: Harness): Harness => ({ ...base, instructions: `${base.instructions} ${PLANTED_REGRESSION}` });

export type Arm = 'A' | 'B' | 'C' | 'D' | 'N' | 'P';
export interface ArmRow {
  attempt: number;
  arm: Arm;
  accepted: boolean;
  reason: string;
  model: string;
  date: string;
  passK: Record<string, number | null>;
}

export interface LoggedRun {
  key: string;
  caseId: string;
  repeat: number;
  run: ProbeRun;
}

export interface ArmContext {
  model: string;
  date: string;
  log: readonly LoggedRun[];
  cases: readonly string[];
  holdout: readonly string[];
  repeats: number;
}

type Recorded = NonNullable<ImproveResult['candidates']>;
type GateInput = Pick<ImproveResult, 'base' | 'final' | 'holdout' | 'costOnPassingCases'>;
type Cost = NonNullable<ImproveResult['costOnPassingCases']>;

const OLD_MAX_COST_INCREASE = 0.2;
const PASS_K = 3;

export function harnessKey(harness: Harness): string {
  return JSON.stringify([harness.instructions, Object.entries(harness.skills).sort(([a], [b]) => a.localeCompare(b))]);
}

function costFailure(cost: Cost, maxCostIncrease: number): string | undefined {
  const rise = cost.final - cost.base;
  if (cost.base <= 0 || rise <= cost.base * maxCostIncrease || rise <= cost.noise) return undefined;
  return `The edit raised cost per passing run by more than ${Math.round(maxCostIncrease * 100)}% and more than noise (${Math.round(cost.base)} to ${Math.round(cost.final)} tokens, noise ${Math.round(cost.noise)}).`;
}

function holdoutDrop(holdout: GateInput['holdout']): string | undefined {
  if (!holdout || holdout.base.passRate === null || holdout.final.passRate === null) return undefined;
  if (holdout.final.passRate >= holdout.base.passRate) return undefined;
  return `A held-out case got worse (${holdout.base.passRate.toFixed(2)} to ${holdout.final.passRate.toFixed(2)}).`;
}

export function gateV1(result: GateInput, maxCostIncrease: number): string | undefined {
  const { base, final } = result;
  if (!final || final.passRate === null || base.passRate === null) return 'The edit could not be scored.';
  const gain = final.passRate - base.passRate;
  const noise = Math.max(base.noise, final.noise);
  if (gain <= 0 || gain <= noise) return `The edit did not beat the base by more than noise (gain ${gain.toFixed(2)}, noise ${noise.toFixed(2)}).`;
  return holdoutDrop(result.holdout) ?? (result.costOnPassingCases && costFailure(result.costOnPassingCases, maxCostIncrease));
}

const skillFile = (name: string, skill: Harness['skills'][string]) => `---\nname: ${name}\ndescription: ${skill.description}\n---\n\n${skill.content}\n`;

function stageTurns(base: Harness, harness: Harness): MockTurn[] {
  if (harnessKey(harness) === harnessKey(base)) return ['<notes>KEEP_BASE.</notes>'];
  const files: [string, string][] = [['harness/instructions.md', harness.instructions], ...Object.entries(harness.skills).map(([name, skill]): [string, string] => [`harness/skills/${name}/SKILL.md`, skillFile(name, skill)])];
  return [{ toolCalls: files.map(([path, content]) => ({ name: 'write_file', args: { path, content } })) }, '<notes>Replayed.</notes>'];
}

export function scriptedEditor(base: Harness, recorded: Recorded): ImproveOptions['editor'] {
  if (Object.keys(base.skills).length > 0) throw new Error('scriptedEditor replays onto a base with no skills, as improveAgent always starts from one.');
  const queues: Record<keyof Recorded, MockTurn[]> = { invariant: stageTurns(base, recorded.invariant), domain: stageTurns(base, recorded.domain), compose: stageTurns(base, recorded.compose) };
  const next: MockTurn = (request) => {
    const stage = stageOf(String(request.messages.find((message) => message.role === 'system')?.content ?? ''));
    const turn = queues[stage].shift();
    if (turn === undefined || typeof turn === 'function') throw new Error(`scriptedEditor has no turn left for the ${stage} editor.`);
    return turn;
  };
  const count = queues.invariant.length + queues.domain.length + queues.compose.length;
  return { provider: mockModel(Array.from({ length: count }, () => next)) };
}

function stageOf(system: string): keyof Recorded {
  if (system.includes('You are the composer.')) return 'compose';
  return system.includes('earliest point of divergence') ? 'invariant' : 'domain';
}

export function loggedProbe(probe: ImproveOptions['probe'], log: LoggedRun[]): ImproveOptions['probe'] {
  return async (harness, caseId, repeat) => {
    const run = await probe(harness, caseId, repeat);
    log.push({ key: harnessKey(harness), caseId, repeat, run });
    return run;
  };
}

const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

function spread(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const middle = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - middle) ** 2, 0) / values.length);
}

function summarize(runs: readonly LoggedRun[]): ProbeSummary {
  const scored = runs.filter(({ run }) => run.passed !== null);
  const repeats = [...new Set(scored.map(({ repeat }) => repeat))].map((repeat) => {
    const own = scored.filter((entry) => entry.repeat === repeat);
    return own.filter(({ run }) => run.passed).length / own.length;
  });
  return {
    runs: runs.length,
    excluded: runs.length - scored.length,
    passRate: scored.length === 0 ? null : scored.filter(({ run }) => run.passed).length / scored.length,
    noise: spread(repeats),
    tokensPerRun: runs.length === 0 ? 0 : mean(runs.map(({ run }) => run.tokens)),
  };
}

const passingTokens = (runs: readonly LoggedRun[], caseId: string) => runs.filter((entry) => entry.caseId === caseId && entry.run.passed).map((entry) => entry.run.tokens);

function oldCost(before: readonly LoggedRun[], after: readonly LoggedRun[]): Cost | undefined {
  const pairs = [...new Set(before.map(({ caseId }) => caseId))].flatMap((caseId) => {
    const base = passingTokens(before, caseId);
    const final = passingTokens(after, caseId);
    if (base.length === 0 || final.length === 0) return [];
    return [{ base: mean(base), final: mean(final), noise: Math.max(spread(base), spread(final)) }];
  });
  if (pairs.length === 0) return undefined;
  return { cases: pairs.length, base: mean(pairs.map((pair) => pair.base)), final: mean(pairs.map((pair) => pair.final)), noise: mean(pairs.map((pair) => pair.noise)) };
}

function lastRuns(log: readonly LoggedRun[], harness: Harness, caseIds: readonly string[], repeats: number): LoggedRun[] {
  const key = harnessKey(harness);
  const latest = new Map<string, LoggedRun>();
  for (const entry of log) if (entry.key === key && caseIds.includes(entry.caseId) && entry.repeat < repeats) latest.set(`${entry.caseId}#${entry.repeat}`, entry);
  return [...latest.values()];
}

function composeView(context: ArmContext, base: Harness, compose: Harness): GateInput {
  const { log, cases, holdout, repeats } = context;
  const trigger = lastRuns(log, base, cases, repeats);
  const final = lastRuns(log, compose, cases, repeats);
  const holdoutBase = lastRuns(log, base, holdout, repeats);
  const holdoutFinal = lastRuns(log, compose, holdout, repeats);
  const cost = oldCost([...trigger, ...holdoutBase], [...final, ...holdoutFinal]);
  return {
    base: summarize(trigger),
    ...(final.length > 0 && { final: summarize(final) }),
    ...(holdout.length > 0 && { holdout: { base: summarize(holdoutBase), final: summarize(holdoutFinal) } }),
    ...(cost && { costOnPassingCases: cost }),
  };
}

function choose(n: number, k: number): number {
  let value = 1;
  for (let i = 0; i < k; i += 1) value = (value * (n - i)) / (i + 1);
  return value;
}

export function passK(count: CaseCount, k: number): number | null {
  if (count.scored < k) return null;
  return choose(count.passed, k) / choose(count.scored, k);
}

function passKFor(log: readonly LoggedRun[], harness: Harness, k = PASS_K): Record<string, number | null> {
  const key = harnessKey(harness);
  const counts = new Map<string, CaseCount>();
  for (const { key: own, caseId, run } of log) {
    if (own !== key || run.passed === null) continue;
    const count = counts.get(caseId) ?? { passed: 0, scored: 0 };
    counts.set(caseId, { passed: count.passed + (run.passed ? 1 : 0), scored: count.scored + 1 });
  }
  return Object.fromEntries([...counts].map(([caseId, count]) => [caseId, passK(count, k)]));
}

function oldGateReason(result: ImproveResult, base: Harness, compose: Harness, context: ArmContext | undefined): string | undefined {
  if (result.gate?.[0]?.label !== 'compose') return 'The composite was not gated.';
  return gateV1(context ? composeView(context, base, compose) : result, OLD_MAX_COST_INCREASE);
}

export function armRow(arm: Arm, attempt: number, verdict: { accepted: boolean; reason: string; shipped: Harness }, base: Harness, context: ArmContext | undefined): ArmRow {
  const passKs = context ? passKFor(context.log, verdict.accepted ? verdict.shipped : base) : {};
  return { attempt, arm, accepted: verdict.accepted, reason: verdict.reason, model: context?.model ?? '', date: context?.date ?? '', passK: passKs };
}

export function armsFromResult(attempt: number, result: ImproveResult, base: Harness, context?: ArmContext): ArmRow[] {
  const compose = result.candidates?.compose ?? base;
  const edited = harnessKey(compose) !== harnessKey(base);
  const old = oldGateReason(result, base, compose, context);
  const composite = result.gate?.[0];
  const verdicts: [Arm, { accepted: boolean; reason: string; shipped: Harness }][] = [
    ['A', { accepted: edited, reason: edited ? 'No gate, so the composite is accepted.' : result.reason, shipped: compose }],
    ['B', { accepted: old === undefined, reason: old ?? 'Passed the old gate.', shipped: compose }],
    ['C', { accepted: composite?.passed === true, reason: composite?.reason ?? result.reason, shipped: compose }],
    ['D', { accepted: result.outcome === 'proposal', reason: result.reason, shipped: result.harness ?? compose }],
  ];
  return verdicts.map(([arm, verdict]) => armRow(arm, attempt, verdict, base, context));
}

export async function admitHoldout(probe: ImproveOptions['probe'], harness: Harness, caseIds: readonly string[], runs: number): Promise<{ caseId: string; passed: number; scored: number }[]> {
  const counts: { caseId: string; passed: number; scored: number }[] = [];
  for (const caseId of caseIds) {
    let passed = 0;
    let scored = 0;
    for (let repeat = 0; repeat < runs; repeat += 1) {
      const { passed: ok } = await probe(harness, caseId, repeat);
      if (ok === null) continue;
      scored += 1;
      if (ok) passed += 1;
    }
    counts.push({ caseId, passed, scored });
  }
  return counts;
}
