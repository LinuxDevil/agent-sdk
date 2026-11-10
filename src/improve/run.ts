import { createAgent } from '../createAgent';
import { CompactedLLMProviderError } from '../execution/errors';
import { MemoryWorkspace } from '../tools/workspace/MemoryWorkspace';
import { createFsTools } from '../tools/workspace/fsTools';
import { editorCacheKey, emptyLedger, readSession, writeSession, type CachedSession } from './cache';
import type { LabelledRun } from './evidence';
import { diffHarness, readHarness, validateHarness } from './harness';
import { rejectedNote } from './prompts';
import type { Harness, ImproveOptions, ImproveOutcome, ImproveResult, ImproveStage } from './types';

const DEFAULT_REPEATS = 3;
const DEFAULT_MAX_ALWAYS_ON = 8000;
const DEFAULT_MAX_EDITOR_STEPS = 30;
const STAGE_ATTEMPTS = 2;
const PARALLEL_SESSIONS = 2;

export class StopRun extends Error {
  constructor(
    readonly outcome: ImproveOutcome,
    reason: string
  ) {
    super(reason);
  }
}

function sessionFailure(error: unknown, timedOut: boolean, timeout: number | undefined): unknown {
  if (timedOut) return new StopRun('outage', `An editor session ran past its ${timeout} ms wall timeout.`);
  if (error instanceof CompactedLLMProviderError && error.compacted.retryable) return new StopRun('outage', `The editor's provider failed: ${error.message}`);
  return error;
}

const notesOf = (text: string) => /<notes>([\s\S]*?)<\/notes>/.exec(text)?.[1]?.trim() ?? text.trim();

interface EditContext {
  signal?: AbortSignal;
  failedChecks?: readonly string[];
}

export class ImproveRun {
  private readonly reserved: ImproveStage[] = [];
  private readonly started = new Set<ImproveStage>();
  tokens = 0;
  readonly ledger = emptyLedger();
  candidates?: NonNullable<ImproveResult['candidates']>;
  readonly repeats: number;
  private readonly maxAlwaysOn: number;
  private readonly failed: [unknown, ImproveStage][] = [];
  private readonly stopped = new Set<ImproveStage>();

  constructor(private readonly options: ImproveOptions) {
    this.repeats = options.repeats ?? DEFAULT_REPEATS;
    this.maxAlwaysOn = options.maxAlwaysOnChars ?? DEFAULT_MAX_ALWAYS_ON;
  }

  private spend(tokens: number): void {
    this.tokens += tokens;
    const { maxTokens } = this.options;
    if (maxTokens !== undefined && this.tokens >= maxTokens) throw new StopRun('budget-exceeded', `Stopped at the ${maxTokens} token budget.`);
  }

  async concurrently<T>(tasks: readonly ((signal: AbortSignal) => Promise<T>)[]): Promise<T[]> {
    const width = this.options.parallelEditors === false ? 1 : PARALLEL_SESSIONS;
    const halt = new AbortController();
    const signal = this.options.signal ? AbortSignal.any([this.options.signal, halt.signal]) : halt.signal;
    const results: T[] = [];
    const errors: unknown[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < tasks.length && !halt.signal.aborted) {
        const index = next++;
        try {
          results[index] = await tasks[index](signal);
        } catch (error) {
          errors.push(error);
          halt.abort();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(width, tasks.length) }, worker));
    if (errors.length === 0) return results;
    const chosen = errors.find((error) => error instanceof StopRun) ?? errors[0];
    this.dropStoppedStages(errors.filter((error) => error !== chosen));
    throw chosen;
  }

  private dropStoppedStages(errors: readonly unknown[]): void {
    for (const [error, stage] of this.failed) {
      if (errors.includes(error)) this.stopped.add(stage);
    }
  }

  async probe(harness: Harness, label: string, caseIds: readonly string[], firstRepeat = 0, count = this.repeats, signal = this.options.signal): Promise<LabelledRun[]> {
    const runs: LabelledRun[] = [];
    for (let repeat = firstRepeat; repeat < firstRepeat + count; repeat += 1) {
      for (const caseId of caseIds) {
        signal?.throwIfAborted();
        const run = await this.options.probe(harness, caseId, repeat);
        this.count(run);
        runs.push({ label, caseId, repeat, run });
        this.spend(run.tokens);
      }
    }
    return runs;
  }

  private count(run: LabelledRun['run']): void {
    this.ledger.planned += 1;
    if (run.cached === true) {
      this.ledger.cached += 1;
      return;
    }
    this.ledger.run += 1;
    if (run.passed === null) this.ledger.excluded += 1;
  }

  private editorModel(): string {
    const { editor } = this.options;
    return 'model' in editor ? editor.model : `${editor.provider.name}/${editor.provider.defaultModel ?? ''}`;
  }

  async ask(system: string, input: string, files: Record<string, string>): Promise<string> {
    const { text, tokens } = await this.session(system, input, new MemoryWorkspace({ files }), this.options.signal, true);
    this.spend(tokens);
    return text;
  }

  private async session(system: string, input: string, workspace: MemoryWorkspace, signal: AbortSignal | undefined, readOnly = false): Promise<{ text: string; tokens: number }> {
    const { editor, editorHooks, maxEditorSteps } = this.options;
    const agent = createAgent({
      name: 'harness-editor',
      ...editor,
      instructions: system,
      tools: createFsTools(workspace, { readOnly }),
      maxSteps: maxEditorSteps ?? DEFAULT_MAX_EDITOR_STEPS,
      ...(editorHooks && { hooks: [...editorHooks] }),
    });
    const timeout = this.options.editorTimeoutMs;
    const timer = timeout === undefined ? undefined : AbortSignal.timeout(timeout);
    const stop = timer && signal ? AbortSignal.any([signal, timer]) : (timer ?? signal);
    try {
      const result = await agent.send(input, stop ? { signal: stop } : undefined);
      stop?.throwIfAborted();
      return { text: result.text ?? '', tokens: result.usage?.totalTokens ?? 0 };
    } catch (error) {
      throw sessionFailure(error, timer?.aborted === true && signal?.aborted !== true, timeout);
    }
  }

  get stages(): ImproveStage[] {
    return this.reserved.filter((stage) => this.started.has(stage) && !this.stopped.has(stage));
  }

  stage(label: ImproveStage['label']): ImproveStage {
    const stage: ImproveStage = { label, status: 'no-change', notes: '', tokens: 0 };
    this.reserved.push(stage);
    return stage;
  }

  async edit(stage: ImproveStage, system: string, files: Record<string, string>, base: Harness, context: EditContext = {}): Promise<Harness> {
    this.started.add(stage);
    try {
      return await this.cachedAttempts(stage, system, files, base, { ...context, signal: context.signal ?? this.options.signal });
    } catch (error) {
      this.failed.push([error, stage]);
      throw error;
    }
  }

  private async cachedAttempts(stage: ImproveStage, system: string, files: Record<string, string>, base: Harness, context: EditContext): Promise<Harness> {
    const checked = this.options.quotedChecks === 'flag' ? undefined : context.failedChecks;
    const limits = { maxAlwaysOnChars: this.maxAlwaysOn, ...(checked && { failedChecks: checked }) };
    const { cacheDir } = this.options;
    if (!cacheDir) return this.attempts(stage, system, new MemoryWorkspace({ files }), base, limits, context.signal);
    const settings = { limits, maxEditorSteps: this.options.maxEditorSteps ?? DEFAULT_MAX_EDITOR_STEPS, attempts: STAGE_ATTEMPTS };
    const key = editorCacheKey({ label: stage.label, system, files, model: this.editorModel(), settings });
    const hit = this.replay(readSession(cacheDir, key), base, limits);
    if (hit) {
      stage.status = hit.stage.status;
      stage.notes = hit.stage.notes;
      if (hit.stage.error !== undefined) stage.error = hit.stage.error;
      return hit.harness;
    }
    const harness = await this.attempts(stage, system, new MemoryWorkspace({ files }), base, limits, context.signal);
    if (stage.status !== 'fell-back') writeSession(cacheDir, key, { harness, stage: { status: stage.status, notes: stage.notes, ...(stage.error !== undefined && { error: stage.error }) } });
    return harness;
  }

  private replay(session: CachedSession | undefined, base: Harness, limits: Parameters<typeof validateHarness>[2]): CachedSession | undefined {
    if (!session || validateHarness(session.harness, base, limits).length > 0) return undefined;
    const changed = diffHarness(base, session.harness) !== '';
    return changed === (session.stage.status === 'edited') ? session : undefined;
  }

  private async attempts(stage: ImproveStage, system: string, workspace: MemoryWorkspace, base: Harness, limits: Parameters<typeof validateHarness>[2], signal: AbortSignal | undefined): Promise<Harness> {
    let input = 'Read the runs in context/runs/, then improve the harness, or say KEEP_BASE.';
    for (let attempt = 1; attempt <= STAGE_ATTEMPTS; attempt += 1) {
      const { text, tokens } = await this.session(system, input, workspace, signal);
      stage.tokens += tokens;
      stage.notes = notesOf(text);
      this.spend(tokens);
      const { harness, errors } = await readHarness(workspace);
      const problems = [...errors, ...validateHarness(harness, base, limits)];
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
