import { ConfigurationError } from '../execution/errors';
import { lastGoodRevision, rollbackHarness } from './apply';
import { appendAudit } from './audit';
import { readCorpus, type CorpusCase } from './corpus';
import type { LabelledRun } from './evidence';
import { caseCount, HOLDOUT_RERUNS, judgePooledHoldout } from './gate';
import { harnessHash, listRevisions, readAgentHarness } from './revisions';
import type { CaseCount, CaseVerdict, Harness, ImproveOptions } from './types';

/** A corpus case's verdict under the current harness. */
export type GuardedCase = CaseVerdict & {
  /** `regressed` takes precedence; `improved` passed more often than its baseline; `inconclusive` had too few scored runs to judge. */
  class: 'regressed' | 'improved' | 'unchanged' | 'inconclusive';
};

/** Options for {@link guardCorpus}. */
export interface GuardCorpusOptions {
  /** Runs one corpus case under a harness; it must resolve corpus ids to their inputs (see `readCorpus`), and a wrapper enforces the token budget. */
  probe: ImproveOptions['probe'];
  /** Fresh runs per case (default 3, at least 2). */
  runs?: number;
  /** Roll back to the last good revision on a regression. */
  rollback: boolean;
  /** The first repeat number (default 200, past the gate's and the canary's); give each guard of one revision its own range when the probe caches runs. */
  firstRepeat?: number;
  /** Stops the guard when aborted. */
  signal?: AbortSignal;
}

/** The verdict of {@link guardCorpus}. */
export interface GuardCorpusResult {
  /** Whether every corpus case was judged and none regressed. */
  passed: boolean;
  /** Each case's verdict and class. */
  cases: GuardedCase[];
  /** The revision it rolled back to, when it did. */
  rolledBackTo?: string;
  /** The revision it guarded. */
  revision: string;
  /** Runs made, including reruns and base runs. */
  runs: number;
  /** Tokens those runs used. */
  tokens: number;
  /** Why, in a sentence or two. */
  reason: string;
}

const DEFAULT_RUNS = 3;
const MIN_RUNS = 2;
const DEFAULT_FIRST_REPEAT = 200;

const rate = (count: CaseCount): number => (count.scored === 0 ? 0 : count.passed / count.scored);
const ratio = (count: CaseCount): string => `${count.passed}/${count.scored}`;
const enough = (count: CaseCount, runs: number): boolean => count.scored >= Math.ceil((runs * 2) / 3);

interface Plan {
  harness: Harness;
  revision: string;
  corpus: CorpusCase[];
  runs: number;
  first: number;
}

async function replay(harness: Harness, ids: readonly string[], options: GuardCorpusOptions, first: number, runs: number): Promise<LabelledRun[]> {
  const labelled: LabelledRun[] = [];
  for (let repeat = first; repeat < first + runs; repeat += 1) {
    for (const caseId of ids) {
      options.signal?.throwIfAborted();
      labelled.push({ label: 'guard', caseId, repeat, run: await options.probe(harness, caseId, repeat) });
    }
  }
  return labelled;
}

function verdict(item: CorpusCase, base: CaseCount, final: CaseCount, reason: string, kind: GuardedCase['class']): GuardedCase {
  return { caseId: item.id, role: 'holdout', base, final, reasons: [reason], class: kind };
}

function held(item: CorpusCase, final: CaseCount, runs: number): GuardedCase {
  if (!enough(final, runs)) return verdict(item, item.baseline, final, `Only ${final.scored} of ${runs} runs could be scored, too few to judge.`, 'inconclusive');
  const kind = rate(final) > rate(item.baseline) ? 'improved' : 'unchanged';
  return verdict(item, item.baseline, final, `Held: ${ratio(item.baseline)} when admitted, ${ratio(final)} now.`, kind);
}

function baseHarnessOf(dir: string, item: CorpusCase, current: string): Harness | undefined {
  const revisions = listRevisions(dir);
  const admittedUnder = revisions.find((revision) => revision.id === item.revision);
  if (admittedUnder) return admittedUnder.harness;
  const good = lastGoodRevision(dir);
  return good && good !== current ? revisions.find((revision) => revision.id === good)?.harness : undefined;
}

function pooledVerdict(item: CorpusCase, base: CaseCount, final: CaseCount, plan: Plan, firstPass: CaseCount): GuardedCase {
  const opening: CaseVerdict = { caseId: item.id, role: 'holdout', base, final: firstPass, reasons: [`Dropped from ${ratio(item.baseline)} when admitted to ${ratio(firstPass)}, so both harnesses ran ${plan.runs + HOLDOUT_RERUNS} times.`] };
  if (!enough(base, plan.runs + HOLDOUT_RERUNS) || !enough(final, plan.runs + HOLDOUT_RERUNS)) return { ...opening, final, reasons: [...opening.reasons, 'Too few pooled runs could be scored to judge.'], class: 'inconclusive' };
  const judged = judgePooledHoldout(item.id, base, final, plan.runs, opening);
  const kind = judged.regressed ? 'regressed' : rate(final) > rate(base) ? 'improved' : 'unchanged';
  return { ...judged.verdict, class: kind };
}

async function judgeDrop(dir: string, item: CorpusCase, firstPass: LabelledRun[], plan: Plan, options: GuardCorpusOptions): Promise<{ verdict: GuardedCase; runs: LabelledRun[] }> {
  const first = caseCount(firstPass, item.id);
  const rerun = await replay(plan.harness, [item.id], options, plan.first + plan.runs, HOLDOUT_RERUNS);
  const final = caseCount([...firstPass, ...rerun], item.id);
  const baseHarness = baseHarnessOf(dir, item, plan.revision);
  if (!baseHarness) {
    const base = item.baseline;
    if (base.scored < plan.runs + HOLDOUT_RERUNS) return { verdict: verdict(item, base, final, `Dropped from ${ratio(base)} to ${ratio(final)}, but no earlier harness is saved to rerun and the baseline is too small to compare.`, 'inconclusive'), runs: rerun };
    return { verdict: pooledVerdict(item, base, final, plan, first), runs: rerun };
  }
  const baseRuns = await replay(baseHarness, [item.id], options, plan.first, plan.runs + HOLDOUT_RERUNS);
  return { verdict: pooledVerdict(item, caseCount(baseRuns, item.id), final, plan, first), runs: [...rerun, ...baseRuns] };
}

function planOf(dir: string, options: GuardCorpusOptions): Plan {
  const runs = options.runs ?? DEFAULT_RUNS;
  if (!Number.isInteger(runs) || runs < MIN_RUNS) throw new ConfigurationError(`guardCorpus: runs must be a whole number of ${MIN_RUNS} or more, got ${runs}.`, 'runs');
  const first = options.firstRepeat ?? DEFAULT_FIRST_REPEAT;
  if (!Number.isInteger(first) || first < 0) throw new ConfigurationError(`guardCorpus: firstRepeat must be a whole number of 0 or more, got ${first}.`, 'firstRepeat');
  const harness = readAgentHarness(dir);
  return { harness, revision: harnessHash(harness), corpus: readCorpus(dir), runs, first };
}

async function judgeAll(dir: string, plan: Plan, options: GuardCorpusOptions): Promise<{ cases: GuardedCase[]; all: LabelledRun[] }> {
  const firstPass = await replay(plan.harness, plan.corpus.map((item) => item.id), options, plan.first, plan.runs);
  const all = [...firstPass];
  const cases: GuardedCase[] = [];
  for (const item of plan.corpus) {
    const count = caseCount(firstPass, item.id);
    if (!enough(count, plan.runs) || rate(count) >= rate(item.baseline)) {
      cases.push(held(item, count, plan.runs));
      continue;
    }
    const judged = await judgeDrop(dir, item, firstPass, plan, options);
    cases.push(judged.verdict);
    all.push(...judged.runs);
  }
  return { cases, all };
}

async function rollBack(dir: string, plan: Plan, reason: string): Promise<{ rolledBackTo?: string; note: string }> {
  const target = lastGoodRevision(dir);
  if (!target || target === plan.revision) return { note: ' There is no earlier good revision, so it was not rolled back.' };
  try {
    const rolled = await rollbackHarness(dir, target, { actor: 'guard', reason, expectedFrom: plan.revision });
    return { rolledBackTo: rolled.to, note: '' };
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    return { note: ` The rollback was refused: ${error.message}` };
  }
}

/** Replays every corpus case under the current harness, classifies each as regressed, improved or unchanged, and rolls back to the last good revision on any regression. */
export async function guardCorpus(dir: string, options: GuardCorpusOptions): Promise<GuardCorpusResult> {
  const plan = planOf(dir, options);
  const short = plan.revision.slice(0, 12);
  if (plan.corpus.length === 0) return { passed: true, cases: [], revision: plan.revision, runs: 0, tokens: 0, reason: 'The corpus is empty, so there was nothing to guard.' };
  const { cases, all } = await judgeAll(dir, plan, options);
  options.signal?.throwIfAborted();
  const tokens = all.reduce((sum, { run }) => sum + run.tokens, 0);
  const cost = `${all.length} runs (${plan.runs} x ${plan.corpus.length} cases + ${all.length - plan.runs * plan.corpus.length} reruns and base runs), ${tokens} tokens`;
  const result = { cases, revision: plan.revision, runs: all.length, tokens };
  const regressed = cases.filter((item) => item.class === 'regressed').map((item) => item.caseId);
  const inconclusive = cases.filter((item) => item.class === 'inconclusive').map((item) => item.caseId);
  if (regressed.length === 0 && inconclusive.length > 0) return { ...result, passed: false, reason: `Too few scored runs to judge ${inconclusive.join(', ')} under ${short}, so the guard neither passed nor failed: ${cost}.` };
  if (regressed.length === 0) {
    const reason = `No corpus case regressed under ${short}: ${cost}.`;
    await appendAudit(dir, { actor: 'guard', action: 'guard-pass', to: plan.revision, reason });
    return { ...result, passed: true, reason };
  }
  const reason = `Corpus cases regressed under ${short} (${regressed.join(', ')}): ${cost}.`;
  await appendAudit(dir, { actor: 'guard', action: 'guard-fail', to: plan.revision, reason });
  if (!options.rollback) return { ...result, passed: false, reason };
  options.signal?.throwIfAborted();
  const { rolledBackTo, note } = await rollBack(dir, plan, reason);
  return { ...result, passed: false, reason: `${reason}${note}`, ...(rolledBackTo && { rolledBackTo }) };
}
