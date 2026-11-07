import type { LabelledRun } from './evidence';
import { caseCount, costNote, costOnPassingCases, gateFailure, HOLDOUT_RERUNS, judgeHoldoutCase, judgePooledHoldout, judgeTrainingCase, summarize, trainingFailure } from './gate';
import { diffHarness } from './harness';
import type { ImproveRun } from './run';
import type { CaseVerdict, GateVerdict, Harness, ImproveOptions, ImproveResult } from './types';

const DEFAULT_MAX_COST_INCREASE = 0.5;

type Judged = Omit<ImproveResult, 'base' | 'stages' | 'spend'>;
type Single = 'invariant' | 'domain';

interface BaseRuns {
  fresh: readonly LabelledRun[];
  holdout: readonly LabelledRun[];
  reruns: Map<string, LabelledRun[]>;
}

async function baseRerun(run: ImproveRun, options: ImproveOptions, base: BaseRuns, id: string): Promise<LabelledRun[]> {
  const made = base.reruns.get(id);
  if (made) return made;
  const runs = await run.probe(options.harness, 'holdout-base-rerun', [id], run.repeats, HOLDOUT_RERUNS);
  base.reruns.set(id, runs);
  return runs;
}

async function holdoutVerdicts(
  run: ImproveRun,
  options: ImproveOptions,
  candidate: Harness,
  label: string,
  base: BaseRuns,
  finalRuns: readonly LabelledRun[]
): Promise<{ verdicts: CaseVerdict[]; regressed: string[] }> {
  const verdicts: CaseVerdict[] = [];
  const regressed: string[] = [];
  for (const id of options.holdout ?? []) {
    const first = judgeHoldoutCase(id, caseCount(base.holdout, id), caseCount(finalRuns, id));
    if (!first.needsRerun) {
      verdicts.push(first.verdict);
      continue;
    }
    const baseRuns = await baseRerun(run, options, base, id);
    const finalRerun = await run.probe(candidate, `${label}-rerun`, [id], run.repeats, HOLDOUT_RERUNS);
    const pooled = judgePooledHoldout(id, caseCount([...base.holdout, ...baseRuns], id), caseCount([...finalRuns, ...finalRerun], id), run.repeats, first.verdict);
    verdicts.push(pooled.verdict);
    if (pooled.regressed) regressed.push(id);
  }
  return { verdicts, regressed };
}

async function gateHarness(run: ImproveRun, options: ImproveOptions, base: BaseRuns, candidate: Harness, finalRuns: readonly LabelledRun[], label: string): Promise<Judged> {
  const holdoutIds = options.holdout ?? [];
  const holdoutFinalRuns = await run.probe(candidate, label, holdoutIds);
  const holdout = holdoutIds.length === 0 ? undefined : { base: summarize(base.holdout), final: summarize(holdoutFinalRuns) };
  const cost = costOnPassingCases([...base.fresh, ...base.holdout], [...finalRuns, ...holdoutFinalRuns]);
  const training = options.cases.map((id) => judgeTrainingCase(id, caseCount(base.fresh, id), caseCount(finalRuns, id)));
  const summaries = { freshBase: summarize(base.fresh), final: summarize(finalRuns), ...(holdout && { holdout }), ...(cost && { costOnPassingCases: cost }) };
  const trainingVerdicts = training.map((judged) => judged.verdict);
  const untrained = trainingFailure(training);
  if (untrained) {
    const firstPass = holdoutIds.map((id) => judgeHoldoutCase(id, caseCount(base.holdout, id), caseCount(holdoutFinalRuns, id), false).verdict);
    return { outcome: 'keep-base', reason: untrained, ...summaries, cases: [...trainingVerdicts, ...firstPass] };
  }
  const { verdicts, regressed } = await holdoutVerdicts(run, options, candidate, label, base, holdoutFinalRuns);
  const failure = gateFailure({ training, regressed, ...(cost && { cost }), maxCostIncrease: options.maxCostIncrease ?? DEFAULT_MAX_COST_INCREASE });
  const shared = { ...summaries, cases: [...trainingVerdicts, ...verdicts] };
  if (failure) return { outcome: 'keep-base', reason: failure, ...shared };
  const reason = `A training case improved by at least 2 in 3 runs, none got worse, and no held-out case got worse.${costNote(cost)}`;
  return { outcome: 'proposal', reason, harness: candidate, diff: diffHarness(options.harness, candidate), ...shared };
}

async function judgeComposite(run: ImproveRun, options: ImproveOptions, composed: Harness): Promise<{ base: BaseRuns; result: Judged }> {
  const fresh = await run.probe(options.harness, 'fresh-base', options.cases, run.repeats);
  const finalRuns = await run.probe(composed, 'final', options.cases);
  const holdout = await run.probe(options.harness, 'holdout-base', options.holdout ?? []);
  const base: BaseRuns = { fresh, holdout, reruns: new Map() };
  return { base, result: await gateHarness(run, options, base, composed, finalRuns, 'holdout-final') };
}

function ineligibility(options: ImproveOptions, harnesses: Record<GateVerdict['label'], Harness>, label: Single, runs: readonly LabelledRun[], fresh: readonly LabelledRun[]): string | undefined {
  const candidate = harnesses[label];
  if (diffHarness(options.harness, candidate) === '') return 'Made no change.';
  if (diffHarness(harnesses.compose, candidate) === '') return 'Same as the composite, so it was not judged again.';
  if (label === 'domain' && diffHarness(harnesses.invariant, candidate) === '') return "Same as the invariant editor's harness, so it was not judged again.";
  const failure = trainingFailure(options.cases.map((id) => judgeTrainingCase(id, caseCount(fresh, id), caseCount(runs, id))));
  return failure && `Failed on training: ${failure}`;
}

function sortCandidates(options: ImproveOptions, harnesses: Record<GateVerdict['label'], Harness>, candidateRuns: Record<Single, readonly LabelledRun[]>, fresh: readonly LabelledRun[]) {
  const eligible: Single[] = [];
  const ineligible: GateVerdict[] = [];
  for (const label of ['invariant', 'domain'] as const) {
    const reason = ineligibility(options, harnesses, label, candidateRuns[label], fresh);
    if (reason) ineligible.push({ label, passed: false, reason });
    else eligible.push(label);
  }
  eligible.sort((a, b) => summarize(candidateRuns[a]).tokensPerRun - summarize(candidateRuns[b]).tokensPerRun);
  return { eligible, ineligible };
}

export async function judgeWithFallback(
  run: ImproveRun,
  options: ImproveOptions,
  harnesses: Record<GateVerdict['label'], Harness>,
  candidateRuns: Record<Single, readonly LabelledRun[]>
): Promise<Judged> {
  const { base, result } = await judgeComposite(run, options, harnesses.compose);
  const compose: GateVerdict = { label: 'compose', passed: result.outcome === 'proposal', reason: result.reason };
  if (compose.passed) return { ...result, gate: [compose] };
  const { eligible, ineligible } = sortCandidates(options, harnesses, candidateRuns, base.fresh);
  const tried: GateVerdict[] = [];
  for (const label of eligible) {
    const judged = await gateHarness(run, options, base, harnesses[label], candidateRuns[label], `holdout-${label}`);
    tried.push({ label, passed: judged.outcome === 'proposal', reason: judged.reason });
    if (judged.outcome !== 'proposal') continue;
    const reason = `The composite failed the gate (${result.reason}) The ${label} editor's harness passed instead.${costNote(judged.costOnPassingCases)}`;
    return { ...judged, reason, gate: [compose, ...tried, ...ineligible] };
  }
  return { ...result, gate: [compose, ...tried, ...ineligible] };
}
