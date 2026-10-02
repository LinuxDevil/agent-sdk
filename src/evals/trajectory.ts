/**
 * Trajectory evals (LOU-D7): the `t` test context handed to
 * `defineEval({ async test(t, c) { ... } })`.
 *
 * Assertions never throw; each one is recorded on the context (gate or
 * soft) and the case fails once at the end, with every failed gate listed.
 */
import type { SimpleAgent } from '../createAgent';
import type { ExecutionResult } from '../execution/AgentExecutor';
import type { LLMProvider } from '../providers/llm';
import type { AgentInput } from '../providers/content';
import { llmJudge } from './llmJudge';
import type { Check } from './checks';
import type { AssertionKind, AssertionResult, EvalResult, EvalToolCall } from './evalResult';
import { gateFailures } from './evalResult';
import { describeCalled, diffArgs, isSubsequence, parseToolCalls } from './toolMatch';
import type { EvalTarget, RemoteExecutionResult } from './remoteTarget';
import { SDKError } from '../execution/errors';

/** The judge provider a trajectory eval grades with, set via `defineEval({ judge })`. */
export interface EvalJudgeConfig {
  /** Provider that grades replies. Use `mockModel` in CI, a real provider in `*.judge.eval.ts`. */
  provider: LLMProvider;
  /** Model id the judge runs on. */
  model: string;
  temperature?: number;
}

/** An agent (or a remote target), or a factory that builds a fresh one per case. */
export type AgentSource = SimpleAgent | EvalTarget | (() => SimpleAgent | EvalTarget | Promise<SimpleAgent | EvalTarget>);

/** Options for {@link EvalTestContext.calledTool}. */
export interface CalledToolOptions {
  /** Partial deep match: the call's arguments must contain these keys with equal values. */
  args?: Record<string, unknown>;
  /** Exact number of (matching) calls. Without it, one or more calls pass. */
  times?: number;
}

/**
 * The test context of a trajectory eval. Send messages, then assert on the
 * run. Gate assertions fail the eval; `soft()` ones are reported only.
 *
 * @example
 * ```ts
 * async test(t) {
 *   await t.send('Refund order 42');
 *   t.completed();
 *   t.calledTool('lookup_order', { args: { orderId: '42' } });
 *   t.check('mentions policy', t.reply, includes('30 days'));
 * }
 * ```
 */
export interface EvalTestContext {
  /** Runs the agent on `message`. May be called more than once; assertions look at all runs. */
  send(message: AgentInput): Promise<ExecutionResult>;
  /** Text of the latest reply (empty before the first `send()`). */
  readonly reply: string;
  /** The latest run, or `undefined` before the first `send()`. */
  readonly result: ExecutionResult | undefined;
  /** Every tool call made so far, in order, with parsed arguments. */
  readonly toolCalls: readonly EvalToolCall[];
  /** Gate: the latest run ended with a normal stop (not error, aborted, awaiting approval or maxSteps). */
  completed(): void;
  /** Gate: the tool was called (optionally with matching `args` / an exact `times`). */
  calledTool(name: string, options?: CalledToolOptions): void;
  /** Gate: the tool was never called. */
  notCalledTool(name: string): void;
  /** Gate: these tools were called in this order (other calls may sit in between). */
  toolOrder(names: readonly string[]): void;
  /** Gate: total model steps are at most `limit`. */
  maxSteps(limit: number): void;
  /** Gate: total tokens are at most `limit`. */
  maxTokens(limit: number): void;
  /** Gate: reported cost is at most `limit` USD. Skipped when the run reports no cost. */
  maxCostUsd(limit: number): void;
  /** Named gate assertion: `check` must pass for `value`. */
  check<T>(name: string, value: T, check: Check<T>): void;
  /** Named soft assertion: recorded with its score, never fails the eval (unless `--strict`). */
  soft<T>(name: string, value: T, check: Check<T>): void;
  /**
   * Grades the latest reply against `rubric` with the eval's judge provider
   * and returns a 0..1 score. Throws unless `defineEval({ judge })` is set.
   */
  judge(rubric: string): Promise<number>;
}

const NO_JUDGE_MESSAGE =
  't.judge() needs a judge provider. Pass `judge: { provider, model }` to defineEval() - ' +
  'use mockModel for a deterministic CI eval, or put the eval in a "*.judge.eval.ts" file ' +
  '(run by `lousho eval --judge`) with a real provider. lousho never calls a real LLM unless you configure one.';

const REMOTE_MISSING = (what: string) => `the remote stream carried no ${what}, so this cannot be checked against a deployment`;

function sumUsage(results: readonly ExecutionResult[]): EvalResult['usage'] {
  if (results.length === 0) return undefined;
  const total = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  for (const { usage } of results) {
    total.promptTokens += usage?.promptTokens ?? 0;
    total.completionTokens += usage?.completionTokens ?? 0;
    total.totalTokens += usage?.totalTokens ?? 0;
  }
  return total;
}

/** Implementation of {@link EvalTestContext}; also builds the case's {@link EvalResult}. */
class TrajectoryContext implements EvalTestContext {
  private readonly results: ExecutionResult[] = [];
  private readonly calls: EvalToolCall[] = [];
  private readonly recorded: AssertionResult[] = [];
  private agent: EvalTarget | undefined;

  /**
   * @param agentSource the agent, or a factory called once, on the first
   *   `send()`, so every case gets its own instance
   */
  constructor(
    private readonly agentSource: AgentSource,
    private readonly judgeConfig?: EvalJudgeConfig
  ) {}

  get result(): ExecutionResult | undefined {
    return this.results.at(-1);
  }

  get reply(): string {
    return this.result?.text ?? '';
  }

  get toolCalls(): readonly EvalToolCall[] {
    return this.calls;
  }

  get assertions(): readonly AssertionResult[] {
    return this.recorded;
  }

  async send(message: AgentInput): Promise<ExecutionResult> {
    this.agent ??= typeof this.agentSource === 'function' ? await this.agentSource() : this.agentSource;
    const result = await this.agent.send(message);
    this.results.push(result);
    this.calls.push(...parseToolCalls(result.toolCalls ?? []));
    return result;
  }

  completed(): void {
    const reason = this.result?.finishReason;
    const passed = reason === 'stop';
    const detail =
      this.result === undefined
        ? 'no run yet - call t.send() first'
        : `finishReason was '${reason}'${reason === 'max-steps' ? ' (the run hit maxSteps while still calling tools)' : ''}`;
    this.gate('completed()', passed, passed ? undefined : `completed() failed: ${detail}`);
  }

  calledTool(name: string, options: CalledToolOptions = {}): void {
    const label = options.args || options.times !== undefined ? `calledTool('${name}', ${JSON.stringify(options)})` : `calledTool('${name}')`;
    const problem = this.calledToolProblem(name, options);
    this.gate(label, problem === undefined, problem === undefined ? undefined : `${label} failed: ${problem}`);
  }

  notCalledTool(name: string): void {
    const count = this.calls.filter((call) => call.name === name).length;
    const label = `notCalledTool('${name}')`;
    this.gate(label, count === 0, count === 0 ? undefined : `${label} failed: '${name}' was called ${count} time(s); tools called were ${describeCalled(this.calls)}`);
  }

  toolOrder(names: readonly string[]): void {
    const passed = isSubsequence(this.calls, names);
    const label = `toolOrder([${names.join(', ')}])`;
    this.gate(label, passed, passed ? undefined : `${label} failed: tools called were ${describeCalled(this.calls)}`);
  }

  maxSteps(limit: number): void {
    if (this.missingFromRemote('steps')) return this.gate(`maxSteps(${limit})`, false, `maxSteps(${limit}) failed: ${REMOTE_MISSING('step events')}`);
    const steps = this.totalSteps();
    this.gate(`maxSteps(${limit})`, steps <= limit, `maxSteps(${limit}) failed: the agent took ${steps} steps`);
  }

  maxTokens(limit: number): void {
    if (this.missingFromRemote('usage')) return this.gate(`maxTokens(${limit})`, false, `maxTokens(${limit}) failed: ${REMOTE_MISSING('usage')}`);
    const tokens = sumUsage(this.results)?.totalTokens ?? 0;
    this.gate(`maxTokens(${limit})`, tokens <= limit, `maxTokens(${limit}) failed: the agent used ${tokens} tokens`);
  }

  maxCostUsd(limit: number): void {
    const label = `maxCostUsd(${limit})`;
    const costs = this.results.map((r) => (r.usage as { costUsd?: number } | undefined)?.costUsd);
    if (costs.length === 0 || costs.some((cost) => typeof cost !== 'number')) {
      this.recorded.push({
        name: label,
        kind: 'gate',
        passed: true,
        score: 1,
        skipped: true,
        message: `${label} skipped: this run reported no cost (usage.costUsd)`,
      });
      return;
    }
    const total = (costs as number[]).reduce((sum, cost) => sum + cost, 0);
    this.gate(label, total <= limit, `${label} failed: the agent cost $${total}`);
  }

  check<T>(name: string, value: T, check: Check<T>): void {
    this.scored('gate', name, value, check);
  }

  soft<T>(name: string, value: T, check: Check<T>): void {
    this.scored('soft', name, value, check);
  }

  async judge(rubric: string): Promise<number> {
    if (!this.judgeConfig) throw new SDKError(NO_JUDGE_MESSAGE, 'LOUSHO_EVALS_INVALID');
    if (!this.result) throw new SDKError('t.judge() grades the latest reply - call t.send() first.', 'LOUSHO_EVALS_INVALID', { appendHelp: false });
    const grade = llmJudge({ ...this.judgeConfig, rubric, allowOutsideJudgeRunner: true });
    return grade(this.result);
  }

  /** Builds the case's result from everything recorded so far. */
  toResult(base: Pick<EvalResult, 'name' | 'case' | 'tags' | 'file'>, durationMs: number, error?: string): EvalResult {
    const result: EvalResult = {
      ...base,
      passed: false,
      assertions: [...this.recorded],
      durationMs,
      steps: this.totalSteps(),
      toolCalls: [...this.calls],
      usage: sumUsage(this.results),
      error,
    };
    result.passed = error === undefined && gateFailures(result).length === 0;
    return result;
  }

  private missingFromRemote(field: 'usage' | 'steps'): boolean {
    return this.results.some((result) => (result as Partial<RemoteExecutionResult>).missing?.includes(field));
  }

  private totalSteps(): number {
    return this.results.reduce((sum, result) => sum + (result.steps ?? 0), 0);
  }

  private gate(name: string, passed: boolean, message?: string): void {
    this.recorded.push({ name, kind: 'gate', passed, score: passed ? 1 : 0, threshold: 1, message: passed ? undefined : message });
  }

  private scored<T>(kind: AssertionKind, name: string, value: T, check: Check<T>): void {
    const outcome = check.evaluate(value);
    const message = outcome.passed ? undefined : `${kind === 'soft' ? 'soft ' : ''}check '${name}' failed: ${outcome.message ?? 'check did not pass'}`;
    this.recorded.push({ name, kind, passed: outcome.passed, score: outcome.score, threshold: outcome.threshold, message });
  }

  private calledToolProblem(name: string, options: CalledToolOptions): string | undefined {
    const named = this.calls.filter((call) => call.name === name);
    if (named.length === 0) return `tools called were ${describeCalled(this.calls)}`;
    const matching = options.args ? named.filter((call) => diffArgs(options.args, call.args).length === 0) : named;
    if (options.args && matching.length === 0) return argMismatch(name, named, options.args);
    if (options.times !== undefined && matching.length !== options.times) {
      return `'${name}' was called ${matching.length} time(s), expected ${options.times}`;
    }
    return undefined;
  }
}

/** What {@link runTrajectoryCase} needs from a `defineEval()` trajectory config. */
export interface TrajectoryCaseSpec {
  name: string;
  tags?: string[];
  agent: AgentSource;
  judge?: EvalJudgeConfig;
  test(t: EvalTestContext, c: unknown): void | Promise<void>;
}

/**
 * Runs one case of a trajectory eval and returns its result. Never throws:
 * an error from `test` (a failed `send()`, an unconfigured `t.judge()`) is
 * recorded as the result's `error`.
 */
export async function runTrajectoryCase(
  spec: TrajectoryCaseSpec,
  c: unknown,
  label: string | undefined,
  file: string | undefined
): Promise<EvalResult> {
  const started = Date.now();
  const context = new TrajectoryContext(spec.agent, spec.judge);
  let error: string | undefined;
  try {
    await spec.test(context, c);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const base = { name: spec.name, case: label, tags: spec.tags ?? [], file };
  return context.toResult(base, Date.now() - started, error);
}

/** The error message a failed case throws into vitest: every failed gate, one per line. */
export function describeFailure(result: EvalResult): string {
  const label = result.case ? `${result.name} [${result.case}]` : result.name;
  const lines = gateFailures(result).map((a) => `  - ${a.message ?? a.name}`);
  if (result.error) lines.push(`  - ${result.error}`);
  return `${label} failed:\n${lines.join('\n')}`;
}

function argMismatch(name: string, named: readonly EvalToolCall[], expected: Record<string, unknown>): string {
  const diffs = named.map((call) => diffArgs(expected, call.args));
  const closest = diffs.reduce((best, current) => (current.length < best.length ? current : best));
  return `'${name}' was called ${named.length} time(s) but no call matched the expected args; closest call differs in ${closest.join('; ')}`;
}
