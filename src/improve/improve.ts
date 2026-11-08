import { createAgent } from '../createAgent';
import { CompactedLLMProviderError, ConfigurationError } from '../execution/errors';
import { MemoryWorkspace } from '../tools/workspace/MemoryWorkspace';
import { createFsTools } from '../tools/workspace/fsTools';
import { evidenceFiles, type LabelledRun } from './evidence';
import { caseCount, costOnPassingCases, gateFailure, judgeTrainingCase, summarize } from './gate';
import { diffHarness, harnessFiles, readHarness, validateHarness } from './harness';
import { COMPOSE_PROMPT, DOMAIN_PROMPT, INVARIANT_PROMPT, rejectedNote } from './prompts';
import type { Harness, ImproveOptions, ImproveOutcome, ImproveResult, ImproveStage, ProbeSummary } from './types';

const DEFAULT_REPEATS = 3;
const DEFAULT_MAX_ALWAYS_ON = 8000;
const DEFAULT_MAX_COST_INCREASE = 0.2;
const DEFAULT_MAX_EDITOR_STEPS = 30;
const STAGE_ATTEMPTS = 2;

class StopRun extends Error {
  constructor(
    readonly outcome: ImproveOutcome,
    reason: string
  ) {
    super(reason);
  }
}

function assertOptions(options: ImproveOptions, repeats: number): void {
  if (options.cases.length === 0) throw new ConfigurationError('improveAgent: cases must name at least one case.', 'cases');
  if (!Number.isInteger(repeats) || repeats <= 0) throw new ConfigurationError(`improveAgent: repeats must be a positive whole number, got ${repeats}.`, 'repeats');
  const overlap = (options.holdout ?? []).filter((id) => options.cases.includes(id));
  if (overlap.length > 0) throw new ConfigurationError(`improveAgent: ${overlap.join(', ')} can't be both a case and held out.`, 'holdout');
}

function needsNoEdit(summary: ProbeSummary, alwaysPropose: boolean | undefined): boolean {
  return summary.passRate === 1 && !alwaysPropose;
}

const notesOf = (text: string) => /<notes>([\s\S]*?)<\/notes>/.exec(text)?.[1]?.trim() ?? text.trim();

class ImproveRun {
  readonly stages: ImproveStage[] = [];
  tokens = 0;
  candidates?: NonNullable<ImproveResult['candidates']>;
  readonly repeats: number;
  private readonly maxAlwaysOn: number;

  constructor(private readonly options: ImproveOptions) {
    this.repeats = options.repeats ?? DEFAULT_REPEATS;
    this.maxAlwaysOn = options.maxAlwaysOnChars ?? DEFAULT_MAX_ALWAYS_ON;
    assertOptions(options, this.repeats);
  }

  private spend(tokens: number): void {
    this.tokens += tokens;
    const { maxTokens } = this.options;
    if (maxTokens !== undefined && this.tokens >= maxTokens) throw new StopRun('budget-exceeded', `Stopped at the ${maxTokens} token budget.`);
  }

  async probe(harness: Harness, label: string, caseIds: readonly string[], firstRepeat = 0, count = this.repeats): Promise<LabelledRun[]> {
    const runs: LabelledRun[] = [];
    for (let repeat = firstRepeat; repeat < firstRepeat + count; repeat += 1) {
      for (const caseId of caseIds) {
        this.options.signal?.throwIfAborted();
        const run = await this.options.probe(harness, caseId, repeat);
        runs.push({ label, caseId, repeat, run });
        this.spend(run.tokens);
      }
    }
    return runs;
  }

  private async session(system: string, input: string, workspace: MemoryWorkspace): Promise<{ text: string; tokens: number }> {
    const { editor, editorHooks, signal, maxEditorSteps } = this.options;
    const agent = createAgent({
      name: 'harness-editor',
      ...editor,
      instructions: system,
      tools: createFsTools(workspace),
      maxSteps: maxEditorSteps ?? DEFAULT_MAX_EDITOR_STEPS,
      ...(editorHooks && { hooks: [...editorHooks] }),
    });
    try {
      const result = await agent.send(input, signal ? { signal } : undefined);
      return { text: result.text ?? '', tokens: result.usage?.totalTokens ?? 0 };
    } catch (error) {
      if (error instanceof CompactedLLMProviderError && error.compacted.retryable) throw new StopRun('outage', `The editor's provider failed: ${error.message}`);
      throw error;
    }
  }

  async edit(label: ImproveStage['label'], system: string, files: Record<string, string>, base: Harness): Promise<Harness> {
    const workspace = new MemoryWorkspace({ files });
    let input = 'Read the runs in context/runs/, then improve the harness, or say KEEP_BASE.';
    const stage: ImproveStage = { label, status: 'no-change', notes: '', tokens: 0 };
    this.stages.push(stage);
    for (let attempt = 1; attempt <= STAGE_ATTEMPTS; attempt += 1) {
      const { text, tokens } = await this.session(system, input, workspace);
      stage.tokens += tokens;
      stage.notes = notesOf(text);
      this.spend(tokens);
      const { harness, errors } = await readHarness(workspace);
      const problems = [...errors, ...validateHarness(harness, base, { maxAlwaysOnChars: this.maxAlwaysOn })];
      if (problems.length === 0) {
        stage.status = diffHarness(base, harness) === '' ? 'no-change' : 'edited';
        return harness;
      }
      stage.error = problems.join(' ');
      input = rejectedNote(problems);
    }
    stage.status = 'fell-back';
    return base;
  }
}

function candidateFiles(name: string, base: Harness, candidate: Harness): Record<string, string> {
  const files: Record<string, string> = { [`context/candidates/${name}/diff.md`]: diffHarness(base, candidate) || 'No change.' };
  for (const [path, content] of Object.entries(harnessFiles(candidate))) files[`context/candidates/${name}/${path}`] = content;
  return files;
}

async function runStages(run: ImproveRun, options: ImproveOptions, baseRuns: readonly LabelledRun[]): Promise<{ composed: Harness; result?: Omit<ImproveResult, 'base' | 'stages' | 'spend'> }> {
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
  if (diffHarness(base, composed) === '') return { composed, result: { outcome: 'keep-base', reason: 'The editors made no change.' } };
  return { composed };
}

async function judge(run: ImproveRun, options: ImproveOptions, composed: Harness): Promise<Omit<ImproveResult, 'base' | 'stages' | 'spend'>> {
  const freshBaseRuns = await run.probe(options.harness, 'fresh-base', options.cases, run.repeats);
  const holdoutIds = options.holdout ?? [];
  const finalRuns = await run.probe(composed, 'final', options.cases);
  const holdoutBaseRuns = await run.probe(options.harness, 'holdout-base', holdoutIds);
  const holdoutFinalRuns = await run.probe(composed, 'holdout-final', holdoutIds);
  const final = summarize(finalRuns);
  const holdout = holdoutIds.length === 0 ? undefined : { base: summarize(holdoutBaseRuns), final: summarize(holdoutFinalRuns) };
  const freshBase = summarize(freshBaseRuns);
  const cost = costOnPassingCases([...freshBaseRuns, ...holdoutBaseRuns], [...finalRuns, ...holdoutFinalRuns]);
  const training = options.cases.map((id) => judgeTrainingCase(id, caseCount(freshBaseRuns, id), caseCount(finalRuns, id)));
  const failure = gateFailure({ training, ...(holdout && { holdout }), ...(cost && { cost }), maxCostIncrease: options.maxCostIncrease ?? DEFAULT_MAX_COST_INCREASE });
  const shared = { freshBase, final, ...(holdout && { holdout }), ...(cost && { costOnPassingCases: cost }), cases: training.map((judged) => judged.verdict) };
  if (failure) return { outcome: 'keep-base', reason: failure, ...shared };
  const reason = `A training case improved by at least 2 in 3 runs, none got worse, and no held-out case got worse.${cost ? '' : ' Cost could not be compared, because no case passed under both harnesses.'}`;
  return { outcome: 'proposal', reason, harness: composed, diff: diffHarness(options.harness, composed), ...shared };
}

/**
 * Looks for a better harness offline: probes the current one, has two scoped editors propose edits, probes those, composes
 * the result, and gates it against the base. It only ever returns a proposal for a person to review, and applies nothing.
 */
export async function improveAgent(options: ImproveOptions): Promise<ImproveResult> {
  const run = new ImproveRun(options);
  let base: ProbeSummary = summarize([]);
  const finish = (result: Omit<ImproveResult, 'base' | 'stages' | 'spend'>): ImproveResult => ({ ...result, base, ...(run.candidates && { candidates: run.candidates }), stages: run.stages, spend: { tokens: run.tokens } });
  try {
    const baseRuns = await run.probe(options.harness, 'base', options.cases);
    base = summarize(baseRuns);
    if (base.passRate === null) return finish({ outcome: 'outage', reason: 'No run could be scored, so there is nothing to learn from.' });
    if (needsNoEdit(base, options.alwaysPropose)) return finish({ outcome: 'no-failures', reason: 'Every case passed, so no editor ran.' });
    const { composed, result } = await runStages(run, options, baseRuns);
    return finish(result ?? (await judge(run, options, composed)));
  } catch (error) {
    if (error instanceof StopRun) return finish({ outcome: error.outcome, reason: error.message });
    throw error;
  }
}
