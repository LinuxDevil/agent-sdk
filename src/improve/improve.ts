import { createAgent } from '../createAgent';
import { CompactedLLMProviderError, ConfigurationError } from '../execution/errors';
import { MemoryWorkspace } from '../tools/workspace/MemoryWorkspace';
import { createFsTools } from '../tools/workspace/fsTools';
import { evidenceFiles, type LabelledRun } from './evidence';
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

function spread(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

function summarize(runs: readonly LabelledRun[]): ProbeSummary {
  const scored = runs.filter(({ run }) => run.passed !== null);
  const passed = scored.filter(({ run }) => run.passed).length;
  const repeats = [...new Set(scored.map(({ repeat }) => repeat))].map((repeat) => {
    const own = scored.filter((entry) => entry.repeat === repeat);
    return own.filter(({ run }) => run.passed).length / own.length;
  });
  return {
    runs: runs.length,
    excluded: runs.length - scored.length,
    passRate: scored.length === 0 ? null : passed / scored.length,
    noise: spread(repeats),
    tokensPerRun: runs.length === 0 ? 0 : runs.reduce((sum, { run }) => sum + run.tokens, 0) / runs.length,
  };
}

function needsNoEdit(summary: ProbeSummary, alwaysPropose: boolean | undefined): boolean {
  return summary.passRate === 1 && !alwaysPropose;
}

function gateFailure(base: ProbeSummary, final: ProbeSummary, holdout: { base: ProbeSummary; final: ProbeSummary } | undefined, maxCostIncrease: number): string | undefined {
  if (final.passRate === null || base.passRate === null) return 'The edit could not be scored.';
  const gain = final.passRate - base.passRate;
  if (gain <= 0 || gain <= Math.max(base.noise, final.noise)) return `The edit did not beat the base by more than noise (gain ${gain.toFixed(2)}, noise ${Math.max(base.noise, final.noise).toFixed(2)}).`;
  if (holdout && holdout.base.passRate !== null && holdout.final.passRate !== null && holdout.final.passRate < holdout.base.passRate) {
    return `A held-out case got worse (${holdout.base.passRate.toFixed(2)} to ${holdout.final.passRate.toFixed(2)}).`;
  }
  if (base.tokensPerRun > 0 && final.tokensPerRun > base.tokensPerRun * (1 + maxCostIncrease)) return `The edit raised cost per run by more than ${Math.round(maxCostIncrease * 100)}% (${Math.round(base.tokensPerRun)} to ${Math.round(final.tokensPerRun)} tokens).`;
  return undefined;
}

const notesOf = (text: string) => /<notes>([\s\S]*?)<\/notes>/.exec(text)?.[1]?.trim() ?? text.trim();

class ImproveRun {
  readonly stages: ImproveStage[] = [];
  tokens = 0;
  private readonly repeats: number;
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

  async probe(harness: Harness, label: string, caseIds: readonly string[]): Promise<LabelledRun[]> {
    const runs: LabelledRun[] = [];
    for (let repeat = 0; repeat < this.repeats; repeat += 1) {
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
  if (diffHarness(base, composed) === '') return { composed, result: { outcome: 'keep-base', reason: 'The editors made no change.' } };
  return { composed };
}

async function judge(run: ImproveRun, options: ImproveOptions, composed: Harness, base: ProbeSummary): Promise<Omit<ImproveResult, 'base' | 'stages' | 'spend'>> {
  const holdoutIds = options.holdout ?? [];
  const final = summarize(await run.probe(composed, 'final', options.cases));
  const holdout = holdoutIds.length === 0 ? undefined : { base: summarize(await run.probe(options.harness, 'holdout-base', holdoutIds)), final: summarize(await run.probe(composed, 'holdout-final', holdoutIds)) };
  const failure = gateFailure(base, final, holdout, options.maxCostIncrease ?? DEFAULT_MAX_COST_INCREASE);
  const shared = { final, ...(holdout && { holdout }) };
  if (failure) return { outcome: 'keep-base', reason: failure, ...shared };
  return { outcome: 'proposal', reason: 'The edit beat the base by more than noise, with no held-out regression.', harness: composed, diff: diffHarness(options.harness, composed), ...shared };
}

/**
 * Looks for a better harness offline: probes the current one, has two scoped editors propose edits, probes those, composes
 * the result, and gates it against the base. It only ever returns a proposal for a person to review, and applies nothing.
 */
export async function improveAgent(options: ImproveOptions): Promise<ImproveResult> {
  const run = new ImproveRun(options);
  let base: ProbeSummary = summarize([]);
  const finish = (result: Omit<ImproveResult, 'base' | 'stages' | 'spend'>): ImproveResult => ({ ...result, base, stages: run.stages, spend: { tokens: run.tokens } });
  try {
    const baseRuns = await run.probe(options.harness, 'base', options.cases);
    base = summarize(baseRuns);
    if (base.passRate === null) return finish({ outcome: 'outage', reason: 'No run could be scored, so there is nothing to learn from.' });
    if (needsNoEdit(base, options.alwaysPropose)) return finish({ outcome: 'no-failures', reason: 'Every case passed, so no editor ran.' });
    const { composed, result } = await runStages(run, options, baseRuns);
    return finish(result ?? (await judge(run, options, composed, base)));
  } catch (error) {
    if (error instanceof StopRun) return finish({ outcome: error.outcome, reason: error.message });
    throw error;
  }
}
