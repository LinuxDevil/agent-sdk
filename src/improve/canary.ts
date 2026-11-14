import { ConfigurationError } from '../execution/errors';
import type { LabelledRun } from './evidence';
import { caseCount } from './gate';
import type { CaseCount, CaseVerdict, Harness, ImproveOptions } from './types';

const DEFAULT_RUNS = 6;
const DEFAULT_FIRST_REPEAT = 100;
const MIN_SCORED_RUNS = 4;
const PASS_BAR = 5 / 6;
const MAX_DROP_RUNS = 2;
const NOT_RUN: CaseCount = { passed: 0, scored: 0 };

/** Options for {@link canaryReplay}. */
export interface CanaryReplayOptions {
  /** The current harness, run on a protected case only when the candidate misses the bar on it. */
  base: Harness;
  /** The harness the gate passed. */
  candidate: Harness;
  /** Ids of the cases the editors learned from. */
  training: readonly string[];
  /** Ids of the held-out and corpus cases the candidate must not break. */
  protected: readonly string[];
  /** Runs one case under a harness, as for {@link improveAgent}. */
  probe: ImproveOptions['probe'];
  /** Fresh runs per case, per harness (default 6, at least 4). */
  runs?: number;
  /** The first repeat number, past any the gate used, so a caching probe never reuses a gate run (default 100, which assumes the gate's `repeats` is 50 or fewer). */
  firstRepeat?: number;
  /** Stops the replay when aborted. */
  signal?: AbortSignal;
}

/** The verdict of {@link canaryReplay}. */
export interface CanaryReplayResult {
  /** Whether the candidate held up on fresh runs. It is `false` whenever a case had too few scored runs to judge. */
  passed: boolean;
  /** Each case's verdict, training cases first. `base` is `0/0` where the base wasn't run. */
  cases: CaseVerdict[];
  /** Why, in a sentence. */
  reason: string;
  /** Tokens the replay's runs used. */
  tokens: number;
}

type Status = 'pass' | 'fail' | 'too-few';

interface Judged {
  verdict: CaseVerdict;
  status: Status;
}

const rate = (count: CaseCount) => count.passed / count.scored;
const ratio = (count: CaseCount) => `${count.passed}/${count.scored}`;
const meetsBar = (count: CaseCount) => rate(count) >= PASS_BAR - 1e-9;
const tooFew = (count: CaseCount) => count.scored < MIN_SCORED_RUNS;
const TOO_FEW = `Fewer than ${MIN_SCORED_RUNS} runs could be scored, too few to judge.`;

function verdictOf(caseId: string, role: CaseVerdict['role'], base: CaseCount, final: CaseCount, status: Status, reason: string): Judged {
  return { verdict: { caseId, role, base, final, reasons: [reason] }, status };
}

function judgeTraining(caseId: string, final: CaseCount): Judged {
  if (tooFew(final)) return verdictOf(caseId, 'training', NOT_RUN, final, 'too-few', TOO_FEW);
  if (meetsBar(final)) return verdictOf(caseId, 'training', NOT_RUN, final, 'pass', `Passed ${ratio(final)} fresh runs.`);
  return verdictOf(caseId, 'training', NOT_RUN, final, 'fail', `Passed ${ratio(final)} fresh runs, below the 5-in-6 bar.`);
}

function judgeProtected(caseId: string, base: CaseCount, final: CaseCount, runs: number): Judged {
  if (tooFew(base)) return verdictOf(caseId, 'holdout', base, final, 'too-few', `Passed ${ratio(final)} fresh runs, but fewer than ${MIN_SCORED_RUNS} base runs could be scored, too few to judge.`);
  if (meetsBar(base)) return verdictOf(caseId, 'holdout', base, final, 'fail', `Passed ${ratio(final)} fresh runs, below the 5-in-6 bar the base met at ${ratio(base)}.`);
  const drop = rate(base) - rate(final);
  if (drop >= MAX_DROP_RUNS / runs - 1e-9) return verdictOf(caseId, 'holdout', base, final, 'fail', `Passed ${ratio(final)} fresh runs against the base's ${ratio(base)}, a drop of ${MAX_DROP_RUNS} or more in ${runs}.`);
  if (drop <= 0) return verdictOf(caseId, 'holdout', base, final, 'pass', `Passed ${ratio(final)} fresh runs, no worse than the base's ${ratio(base)}, which also missed the bar.`);
  return verdictOf(caseId, 'holdout', base, final, 'pass', `Passed ${ratio(final)} fresh runs against the base's ${ratio(base)}, which also missed the bar, a drop of less than ${MAX_DROP_RUNS} in ${runs}.`);
}

async function replay(options: CanaryReplayOptions, harness: Harness, caseIds: readonly string[], runs: number, firstRepeat: number): Promise<LabelledRun[]> {
  const labelled: LabelledRun[] = [];
  for (let repeat = firstRepeat; repeat < firstRepeat + runs; repeat += 1) {
    for (const caseId of caseIds) {
      options.signal?.throwIfAborted();
      labelled.push({ label: 'canary', caseId, repeat, run: await options.probe(harness, caseId, repeat) });
    }
  }
  return labelled;
}

function needsBase(final: CaseCount): boolean {
  return !tooFew(final) && !meetsBar(final);
}

async function judgeAllProtected(options: CanaryReplayOptions, finalRuns: readonly LabelledRun[], runs: number, firstRepeat: number): Promise<{ judged: Judged[]; baseRuns: LabelledRun[] }> {
  const finals = new Map(options.protected.map((id) => [id, caseCount(finalRuns, id)] as const));
  const missed = options.protected.filter((id) => needsBase(finals.get(id) ?? NOT_RUN));
  const baseRuns = await replay(options, options.base, missed, runs, firstRepeat);
  const judged = options.protected.map((id) => {
    const final = finals.get(id) ?? NOT_RUN;
    if (tooFew(final)) return verdictOf(id, 'holdout', NOT_RUN, final, 'too-few', TOO_FEW);
    if (meetsBar(final)) return verdictOf(id, 'holdout', NOT_RUN, final, 'pass', `Held at ${ratio(final)} fresh runs.`);
    return judgeProtected(id, caseCount(baseRuns, id), final, runs);
  });
  return { judged, baseRuns };
}

const idsWith = (judged: readonly Judged[], status: Status) => judged.filter((entry) => entry.status === status).map((entry) => entry.verdict.caseId);

function overallReason(training: readonly Judged[], protectedCases: readonly Judged[]): string | undefined {
  const unscored = idsWith([...training, ...protectedCases], 'too-few');
  if (unscored.length > 0) return `Too few scored runs on ${unscored.join(', ')}, so the canary failed closed.`;
  const failedTraining = idsWith(training, 'fail');
  if (failedTraining.length > 0) return `A training case fell below 5 in 6 fresh runs (${failedTraining.join(', ')}).`;
  const failedProtected = idsWith(protectedCases, 'fail');
  if (failedProtected.length > 0) return `A protected case got worse on fresh runs (${failedProtected.join(', ')}).`;
  return undefined;
}

function assertOptions(options: CanaryReplayOptions, runs: number, firstRepeat: number): void {
  if (!Number.isInteger(runs) || runs < MIN_SCORED_RUNS) throw new ConfigurationError(`canaryReplay: runs must be a whole number of ${MIN_SCORED_RUNS} or more, got ${runs}.`, 'runs');
  const ids = [...options.training, ...options.protected];
  const repeated = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (repeated.length > 0) throw new ConfigurationError(`canaryReplay: ${repeated.join(', ')} must be named once, in training or protected.`, 'protected');
  if (!Number.isInteger(firstRepeat) || firstRepeat < 0) throw new ConfigurationError(`canaryReplay: firstRepeat must be a whole number of 0 or more, got ${firstRepeat}.`, 'firstRepeat');
}

/** Fresh runs of a gated proposal on its training cases and on every protected case, with repeats the gate never used. */
export async function canaryReplay(options: CanaryReplayOptions): Promise<CanaryReplayResult> {
  const runs = options.runs ?? DEFAULT_RUNS;
  const firstRepeat = options.firstRepeat ?? DEFAULT_FIRST_REPEAT;
  assertOptions(options, runs, firstRepeat);
  if (options.training.length === 0) return { passed: false, cases: [], reason: 'There was no training case to replay, so the canary failed closed.', tokens: 0 };
  const finalRuns = await replay(options, options.candidate, [...options.training, ...options.protected], runs, firstRepeat);
  const training = options.training.map((id) => judgeTraining(id, caseCount(finalRuns, id)));
  const { judged: protectedCases, baseRuns } = await judgeAllProtected(options, finalRuns, runs, firstRepeat);
  const cases = [...training, ...protectedCases].map((entry) => entry.verdict);
  const tokens = [...finalRuns, ...baseRuns].reduce((sum, { run }) => sum + run.tokens, 0);
  const failure = overallReason(training, protectedCases);
  if (failure) return { passed: false, cases, reason: failure, tokens };
  return { passed: true, cases, reason: 'Every training case passed at least 5 in 6 fresh runs, and no protected case got worse.', tokens };
}
