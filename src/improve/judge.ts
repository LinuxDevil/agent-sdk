import type { LabelledRun } from './evidence';
import { caseCount, costNote, costOnPassingCases, gateFailure, HOLDOUT_RERUNS, judgeHoldoutCase, judgePooledHoldout, judgeTrainingCase, summarize, trainingFailure } from './gate';
import { diffHarness } from './harness';
import type { ImproveRun } from './run';
import { selectAmong, type Passer } from './select';
import type { CaseVerdict, GateVerdict, Harness, ImproveOptions, ImproveResult } from './types';

const DEFAULT_MAX_COST_INCREASE = 0.5;

type Judged = Omit<ImproveResult, 'base' | 'stages' | 'spend'>;

export const isCheckpoint = (label: string) => label.startsWith('compose');

export interface Proposal {
  label: Exclude<GateVerdict['label'], 'compose'>;
  harness: Harness;
  runs: readonly LabelledRun[];
}

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

async function judgeComposite(run: ImproveRun, options: ImproveOptions, composed: Harness): Promise<{ base: BaseRuns; result: Judged; finalRuns: LabelledRun[] }> {
  const fresh = await run.probe(options.harness, 'fresh-base', options.cases, run.repeats);
  const finalRuns = await run.probe(composed, 'final', options.cases);
  const holdout = await run.probe(options.harness, 'holdout-base', options.holdout ?? []);
  const base: BaseRuns = { fresh, holdout, reruns: new Map() };
  return { base, result: await gateHarness(run, options, base, composed, finalRuns, 'holdout-final'), finalRuns };
}

function ineligibility(options: ImproveOptions, composed: Harness | undefined, pool: readonly Proposal[], index: number, fresh: readonly LabelledRun[]): string | undefined {
  const { harness: candidate, runs } = pool[index];
  if (diffHarness(options.harness, candidate) === '') return 'Made no change.';
  if (composed && diffHarness(composed, candidate) === '') return 'Same as the composite, so it was not judged again.';
  const twin = pool.slice(0, index).find((earlier) => diffHarness(earlier.harness, candidate) === '');
  if (twin) return `Same as the ${twin.label} ${isCheckpoint(twin.label) ? 'checkpoint' : "editor's harness"}, so it was not judged again.`;
  const failure = trainingFailure(options.cases.map((id) => judgeTrainingCase(id, caseCount(fresh, id), caseCount(runs, id))));
  return failure && `Failed on training: ${failure}`;
}

function sortCandidates(options: ImproveOptions, composed: Harness | undefined, pool: readonly Proposal[], fresh: readonly LabelledRun[]) {
  const eligible: Proposal[] = [];
  const ineligible: GateVerdict[] = [];
  pool.forEach((proposal, index) => {
    const reason = ineligibility(options, composed, pool, index, fresh);
    if (reason) ineligible.push({ label: proposal.label, passed: false, reason });
    else eligible.push(proposal);
  });
  eligible.sort((a, b) => summarize(a.runs).tokensPerRun - summarize(b.runs).tokensPerRun);
  return { eligible, ineligible };
}

interface Gated {
  tried: GateVerdict[];
  passers: Passer[];
  failed?: { label: string; judged: Judged };
}

async function gateEach(run: ImproveRun, options: ImproveOptions, base: BaseRuns, eligible: readonly Proposal[], passedReason: (label: string, judged: Judged) => string): Promise<Gated> {
  const gated: Gated = { tried: [], passers: [] };
  for (const { label, harness, runs } of eligible) {
    const judged = await gateHarness(run, options, base, harness, runs, `holdout-${label}`);
    gated.tried.push({ label, passed: judged.outcome === 'proposal', reason: judged.reason });
    if (judged.outcome !== 'proposal') {
      gated.failed ??= { label, judged };
      continue;
    }
    gated.passers.push({ label, harness, runs, judged: { ...judged, reason: passedReason(label, judged) } });
    if (!options.select) break;
  }
  return gated;
}

async function settle(run: ImproveRun, options: ImproveOptions, passers: readonly Passer[]): Promise<Judged> {
  if (passers.length === 1) return passers[0].judged;
  const { chosen, selection } = await selectAmong(run, options, passers);
  const how = selection.fallback ? `the selector gave no usable choice, so the cheapest, ${chosen.label}, was kept` : `the advisory selector chose ${chosen.label}`;
  return { ...chosen.judged, reason: `${chosen.judged.reason} ${passers.length} harnesses passed the gate; ${how}.`, selection };
}

export async function judgeWithFallback(run: ImproveRun, options: ImproveOptions, composed: Harness, pool: readonly Proposal[]): Promise<Judged> {
  const { base, result, finalRuns } = await judgeComposite(run, options, composed);
  const compose: GateVerdict = { label: 'compose', passed: result.outcome === 'proposal', reason: result.reason };
  if (compose.passed && !options.select) return { ...result, gate: [compose] };
  const { eligible, ineligible } = sortCandidates(options, composed, pool, base.fresh);
  const fallbackReason = (label: string, judged: Judged) =>
    compose.passed ? judged.reason : `The composite failed the gate (${result.reason}) The ${label} editor's harness passed instead.${costNote(judged.costOnPassingCases)}`;
  const { tried, passers } = await gateEach(run, options, base, eligible, fallbackReason);
  const all: Passer[] = compose.passed ? [{ label: 'compose', harness: composed, runs: finalRuns, judged: result }, ...passers] : passers;
  const gate = [compose, ...tried, ...ineligible];
  return { ...(all.length > 0 ? await settle(run, options, all) : result), gate };
}

export async function judgeCheckpoints(run: ImproveRun, options: ImproveOptions, checkpoints: readonly Proposal[]): Promise<Judged> {
  const fresh = await run.probe(options.harness, 'fresh-base', options.cases, run.repeats);
  const holdout = await run.probe(options.harness, 'holdout-base', options.holdout ?? []);
  const base: BaseRuns = { fresh, holdout, reruns: new Map() };
  const { eligible, ineligible } = sortCandidates(options, undefined, checkpoints, fresh);
  const { tried, passers, failed } = await gateEach(run, options, base, eligible, (label, judged) => `The ${label} checkpoint passed the gate. ${judged.reason}`);
  const gate = [...tried, ...ineligible];
  if (passers.length > 0) return { ...(await settle(run, options, passers)), gate };
  if (failed) return { ...failed.judged, reason: `The ${failed.label} checkpoint failed the gate: ${failed.judged.reason}`, gate };
  return { outcome: 'keep-base', reason: "No round's checkpoint improved a training case.", freshBase: summarize(fresh), gate };
}
