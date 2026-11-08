import { createAgent } from '../createAgent';
import { CompactedLLMProviderError } from '../execution/errors';
import { MemoryWorkspace } from '../tools/workspace/MemoryWorkspace';
import { createFsTools } from '../tools/workspace/fsTools';
import type { LabelledRun } from './evidence';
import { diffHarness, readHarness, validateHarness } from './harness';
import { rejectedNote } from './prompts';
import type { Harness, ImproveOptions, ImproveOutcome, ImproveResult, ImproveStage } from './types';

const DEFAULT_REPEATS = 3;
const DEFAULT_MAX_ALWAYS_ON = 8000;
const DEFAULT_MAX_EDITOR_STEPS = 30;
const STAGE_ATTEMPTS = 2;

export class StopRun extends Error {
  constructor(
    readonly outcome: ImproveOutcome,
    reason: string
  ) {
    super(reason);
  }
}

const notesOf = (text: string) => /<notes>([\s\S]*?)<\/notes>/.exec(text)?.[1]?.trim() ?? text.trim();

export class ImproveRun {
  readonly stages: ImproveStage[] = [];
  tokens = 0;
  candidates?: NonNullable<ImproveResult['candidates']>;
  readonly repeats: number;
  private readonly maxAlwaysOn: number;

  constructor(private readonly options: ImproveOptions) {
    this.repeats = options.repeats ?? DEFAULT_REPEATS;
    this.maxAlwaysOn = options.maxAlwaysOnChars ?? DEFAULT_MAX_ALWAYS_ON;
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
