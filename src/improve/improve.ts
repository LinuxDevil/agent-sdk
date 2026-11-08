import { ConfigurationError } from '../execution/errors';
import { changeItems } from './changes';
import { evidenceFiles, type LabelledRun } from './evidence';
import { summarize } from './gate';
import { diffHarness, harnessFiles } from './harness';
import { judgeWithFallback } from './judge';
import { COMPOSE_PROMPT, DOMAIN_PROMPT, INVARIANT_PROMPT } from './prompts';
import { ImproveRun, StopRun } from './run';
import type { Harness, ImproveOptions, ImproveResult, ImproveStage, ProbeSummary } from './types';

function assertOptions(options: ImproveOptions, repeats: number): void {
  if (options.cases.length === 0) throw new ConfigurationError('improveAgent: cases must name at least one case.', 'cases');
  if (!Number.isInteger(repeats) || repeats <= 0) throw new ConfigurationError(`improveAgent: repeats must be a positive whole number, got ${repeats}.`, 'repeats');
  const overlap = (options.holdout ?? []).filter((id) => options.cases.includes(id));
  if (overlap.length > 0) throw new ConfigurationError(`improveAgent: ${overlap.join(', ')} can't be both a case and held out.`, 'holdout');
}

function needsNoEdit(summary: ProbeSummary, alwaysPropose: boolean | undefined): boolean {
  return summary.passRate === 1 && !alwaysPropose;
}

function failedChecks(runs: readonly LabelledRun[]): string[] {
  return [...new Set(runs.flatMap(({ run }) => (run.failure ? run.failure.split('; ') : [])))];
}

function winningNotes(result: Pick<ImproveResult, 'gate'>, stages: readonly ImproveStage[]): string {
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
  invariant: Harness;
  domain: Harness;
  invariantRuns: LabelledRun[];
  domainRuns: LabelledRun[];
  result?: Omit<ImproveResult, 'base' | 'stages' | 'spend'>;
}

async function runStages(run: ImproveRun, options: ImproveOptions, baseRuns: readonly LabelledRun[]): Promise<Stages> {
  const { harness: base, cases } = options;
  const shared = evidenceFiles({ harness: base, runs: baseRuns });
  const invariant = await run.edit('invariant', INVARIANT_PROMPT, shared, base);
  const domain = await run.edit('domain', DOMAIN_PROMPT, shared, base);
  const probeIfEdited = (candidate: Harness, label: string) => (diffHarness(base, candidate) === '' ? Promise.resolve([]) : run.probe(candidate, label, cases));
  const invariantRuns = await probeIfEdited(invariant, 'invariant');
  const domainRuns = await probeIfEdited(domain, 'domain');
  const composeFiles = evidenceFiles({
    harness: base,
    runs: [...baseRuns, ...invariantRuns, ...domainRuns],
    extra: { ...candidateFiles('invariant', base, invariant), ...candidateFiles('domain', base, domain) },
  });
  const composed = await run.edit('compose', COMPOSE_PROMPT, composeFiles, base);
  run.candidates = { invariant, domain, compose: composed };
  const stages = { composed, invariant, domain, invariantRuns, domainRuns };
  if (diffHarness(base, composed) === '') return { ...stages, result: { outcome: 'keep-base', reason: 'The editors made no change.' } };
  return stages;
}

function judgeStages(run: ImproveRun, options: ImproveOptions, stages: Stages): Promise<Omit<ImproveResult, 'base' | 'stages' | 'spend'>> {
  const harnesses = { compose: stages.composed, invariant: stages.invariant, domain: stages.domain };
  return judgeWithFallback(run, options, harnesses, { invariant: stages.invariantRuns, domain: stages.domainRuns });
}

/**
 * Looks for a better harness offline: probes the current one, has two scoped editors propose edits, probes those, composes
 * the result, and gates it against the base. It only ever returns a proposal for a person to review, and applies nothing.
 */
export async function improveAgent(options: ImproveOptions): Promise<ImproveResult> {
  const run = new ImproveRun(options);
  assertOptions(options, run.repeats);
  let base: ProbeSummary = summarize([]);
  let checks: string[] = [];
  const finish = (result: Omit<ImproveResult, 'base' | 'stages' | 'spend'>): ImproveResult => ({
    ...result,
    ...(result.harness && { changes: changeItems(options.harness, result.harness, winningNotes(result, run.stages)) }),
    ...(checks.length > 0 && { failedChecks: checks }),
    base,
    ...(run.candidates && { candidates: run.candidates }),
    stages: run.stages,
    spend: { tokens: run.tokens },
  });
  try {
    const baseRuns = await run.probe(options.harness, 'base', options.cases);
    base = summarize(baseRuns);
    if (base.passRate === null) return finish({ outcome: 'outage', reason: 'No run could be scored, so there is nothing to learn from.' });
    if (needsNoEdit(base, options.alwaysPropose)) return finish({ outcome: 'no-failures', reason: 'Every case passed, so no editor ran.' });
    checks = failedChecks(baseRuns);
    const stages = await runStages(run, options, baseRuns);
    checks = failedChecks([...baseRuns, ...stages.invariantRuns, ...stages.domainRuns]);
    return finish(stages.result ?? (await judgeStages(run, options, stages)));
  } catch (error) {
    if (error instanceof StopRun) return finish({ outcome: error.outcome, reason: error.message });
    throw error;
  }
}
