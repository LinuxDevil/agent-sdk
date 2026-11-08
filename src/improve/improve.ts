import { ConfigurationError } from '../execution/errors';
import { pruneCache } from './cache';
import { changeItems } from './changes';
import { evidenceFiles, type LabelledRun } from './evidence';
import { summarize } from './gate';
import { diffHarness, harnessFiles } from './harness';
import { diversity } from './diversity';
import { judgeWithFallback, type Proposal } from './judge';
import { isLibraryFile } from './library';
import { candidateNote, COMPOSE_PROMPT, DOMAIN_PROMPT, INVARIANT_PROMPT, LIBRARY_NOTE, poolComposePrompt, RECOVERIES_NOTE } from './prompts';
import { ImproveRun, StopRun } from './run';
import type { Harness, ImproveOptions, ImproveResult, ImproveStage, ProbeSummary } from './types';

function assertOptions(options: ImproveOptions, repeats: number): void {
  if (options.cases.length === 0) throw new ConfigurationError('improveAgent: cases must name at least one case.', 'cases');
  if (!Number.isInteger(repeats) || repeats <= 0) throw new ConfigurationError(`improveAgent: repeats must be a positive whole number, got ${repeats}.`, 'repeats');
  const overlap = (options.holdout ?? []).filter((id) => options.cases.includes(id));
  if (overlap.length > 0) throw new ConfigurationError(`improveAgent: ${overlap.join(', ')} can't be both a case and held out.`, 'holdout');
  const stray = (options.recoveries ?? []).filter((recovery) => !options.cases.includes(recovery.caseId)).map((recovery) => recovery.caseId);
  if (stray.length > 0) throw new ConfigurationError(`improveAgent: recoveries must name training cases, not ${stray.join(', ')}.`, 'recoveries');
  const outside = Object.entries(options.library ?? {}).filter(([path, content]) => !LIBRARY_PATH.test(path) || !isLibraryFile(content));
  if (outside.length > 0) throw new ConfigurationError(`improveAgent: library must hold files from libraryFiles, named context/library/<name>.md, not ${outside.map(([path]) => path).join(', ')}.`, 'library');
  assertProposers(options);
}

const LIBRARY_PATH = /^context\/library\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.md$/;

const MAX_PROPOSERS = 4;

function assertProposers(options: ImproveOptions): void {
  const k = options.proposers ?? 1;
  if (!Number.isInteger(k) || k < 1 || k > MAX_PROPOSERS) throw new ConfigurationError(`improveAgent: proposers must be a whole number from 1 to ${MAX_PROPOSERS}, got ${k}.`, 'proposers');
}

interface Proposer {
  label: Proposal['label'];
  system: string;
}

function promptsFor(options: ImproveOptions): { proposers: Proposer[]; compose: string } {
  const k = options.proposers ?? 1;
  const note = (options.recoveries?.length ? RECOVERIES_NOTE : '') + (Object.keys(options.library ?? {}).length > 0 ? LIBRARY_NOTE : '');
  const proposers = Array.from({ length: k }, (_, i): Proposer[] => {
    const suffix = k === 1 ? '' : (`-${i + 1}` as const);
    const own = k === 1 ? note : note + candidateNote(i + 1, k);
    return [
      { label: `invariant${suffix}`, system: INVARIANT_PROMPT + own },
      { label: `domain${suffix}`, system: DOMAIN_PROMPT + own },
    ];
  }).flat();
  return { proposers, compose: (k === 1 ? COMPOSE_PROMPT : poolComposePrompt(k)) + note };
}

function candidatesOf(pool: readonly Proposal[], compose: Harness, several: boolean): NonNullable<ImproveResult['candidates']> {
  const candidates = { invariant: pool[0].harness, domain: pool[1].harness, compose };
  return several ? { ...candidates, pool: Object.fromEntries(pool.map(({ label, harness }) => [label, harness])) } : candidates;
}

function needsNoEdit(summary: ProbeSummary, alwaysPropose: boolean | undefined): boolean {
  return summary.passRate === 1 && !alwaysPropose;
}

function failedChecks(runs: readonly LabelledRun[]): string[] {
  return [...new Set(runs.flatMap(({ run }) => (run.failure ? run.failure.split('; ') : [])))];
}

export function winningNotes(result: Pick<ImproveResult, 'gate'>, stages: readonly ImproveStage[]): string {
  const label = result.gate?.find((verdict) => verdict.passed)?.label ?? 'compose';
  return stages.find((stage) => stage.label === label)?.notes ?? '';
}

function candidateFiles(name: string, base: Harness, candidate: Harness): Record<string, string> {
  const files: Record<string, string> = { [`context/candidates/${name}/diff.md`]: diffHarness(base, candidate) || 'No change.' };
  for (const [path, content] of Object.entries(harnessFiles(candidate))) files[`context/candidates/${name}/${path}`] = content;
  return files;
}

interface Stages {
  composed: Harness;
  pool: Proposal[];
  result?: Omit<ImproveResult, 'base' | 'stages' | 'spend'>;
}

async function propose(run: ImproveRun, options: ImproveOptions, proposers: readonly Proposer[], baseRuns: readonly LabelledRun[], shared: Record<string, string>): Promise<Proposal[]> {
  const { harness: base, cases } = options;
  const stages = proposers.map(({ label }) => run.stage(label));
  const seen = failedChecks(baseRuns);
  const harnesses = await run.concurrently(proposers.map(({ system }, i) => (signal: AbortSignal) => run.edit(stages[i], system, shared, base, { signal, failedChecks: seen })));
  const probeIfEdited = (candidate: Harness, label: string, signal: AbortSignal) =>
    diffHarness(base, candidate) === '' ? Promise.resolve([]) : run.probe(candidate, label, cases, 0, run.repeats, signal);
  const runs = await run.concurrently(proposers.map(({ label }, i) => (signal: AbortSignal) => probeIfEdited(harnesses[i], label, signal)));
  return proposers.map(({ label }, i) => ({ label, harness: harnesses[i], runs: runs[i] }));
}

async function runStages(run: ImproveRun, options: ImproveOptions, baseRuns: readonly LabelledRun[]): Promise<Stages> {
  const { harness: base, recoveries, library } = options;
  const prompts = promptsFor(options);
  const pool = await propose(run, options, prompts.proposers, baseRuns, evidenceFiles({ harness: base, runs: baseRuns, recoveries, extra: library }));
  const composeRuns = [...baseRuns, ...pool.flatMap((proposal) => proposal.runs)];
  const composeFiles = evidenceFiles({
    harness: base,
    runs: composeRuns,
    recoveries,
    extra: Object.assign({ ...library }, ...pool.map((proposal) => candidateFiles(proposal.label, base, proposal.harness))),
  });
  const composed = await run.edit(run.stage('compose'), prompts.compose, composeFiles, base, { failedChecks: failedChecks(composeRuns) });
  run.candidates = candidatesOf(pool, composed, (options.proposers ?? 1) > 1);
  if (diffHarness(base, composed) === '') return { composed, pool, result: { outcome: 'keep-base', reason: 'The editors made no change.' } };
  return { composed, pool };
}

/**
 * Looks for a better harness offline: probes the current one, has two scoped editors propose edits, probes those, composes
 * the result, and gates it against the base. It only ever returns a proposal for a person to review, and applies nothing.
 */
export async function improveAgent(options: ImproveOptions): Promise<ImproveResult> {
  const run = new ImproveRun(options);
  assertOptions(options, run.repeats);
  if (options.cacheDir) pruneCache(options.cacheDir);
  let base: ProbeSummary = summarize([]);
  let checks: string[] = [];
  const finish = (result: Omit<ImproveResult, 'base' | 'stages' | 'spend'>): ImproveResult => ({
    ...result,
    ...(result.harness && { changes: changeItems(options.harness, result.harness, winningNotes(result, run.stages)) }),
    ...(checks.length > 0 && { failedChecks: checks }),
    base,
    ...(run.candidates && { candidates: run.candidates }),
    ...(run.candidates?.pool && { diversity: diversity(Object.values(run.candidates.pool)) }),
    stages: run.stages,
    ledger: { ...run.ledger },
    spend: { tokens: run.tokens },
  });
  try {
    const baseRuns = await run.probe(options.harness, 'base', options.cases);
    base = summarize(baseRuns);
    if (base.passRate === null) return finish({ outcome: 'outage', reason: 'No run could be scored, so there is nothing to learn from.' });
    if (needsNoEdit(base, options.alwaysPropose)) return finish({ outcome: 'no-failures', reason: 'Every case passed, so no editor ran.' });
    checks = failedChecks(baseRuns);
    const stages = await runStages(run, options, baseRuns);
    checks = failedChecks([...baseRuns, ...stages.pool.flatMap((proposal) => proposal.runs)]);
    return finish(stages.result ?? (await judgeWithFallback(run, options, stages.composed, stages.pool)));
  } catch (error) {
    if (error instanceof StopRun) return finish({ outcome: error.outcome, reason: error.message });
    throw error;
  }
}
