/**
 * defineEval() core API
 *
 * A thin wrapper around vitest's `test()` that runs a real agent through
 * the REAL static AgentExecutor.execute() (this SDK's AgentExecutor has no
 * instance methods - it is a static, instance-free API, see
 * src/execution/AgentExecutor.ts), scores the resulting ExecutionResult
 * with a caller-supplied `score()` function, and asserts the score meets
 * a threshold.
 */

import type * as Vitest from 'vitest';
import { AgentExecutor, ExecuteOptions, ExecutionResult } from '../execution/AgentExecutor';
import { withEvalCassettes } from './cassettes';
import { scoreAssertion, type EvalResult } from './evalResult';
import { matchesTagFilter, recordEvalResult } from './recorder';
import { remoteTargetFromEnv } from './remoteTarget';
import { SDKError } from '../execution/errors';
import {
  collectNested,
  describeFailure,
  mergeNested,
  type NestedCall,
  runTrajectoryCase,
  type AgentSource,
  type EvalJudgeConfig,
  type EvalTestContext,
} from './trajectory';

/**
 * Configuration for a single eval case.
 *
 * The fields that map straight through to AgentExecutor.execute() are
 * deliberately named/typed identically to ExecuteOptions (agent, input,
 * provider, toolRegistry, maxSteps, temperature, maxTokens) so defineEval()
 * can forward them without any reshaping - there is no nested `agent.prompt`
 * / `agent.toolRegistry` shape here, because that is not what execute()
 * actually accepts.
 */
export interface EvalConfig extends Partial<Omit<ExecuteOptions, 'agent' | 'input' | 'provider' | 'onAgentEvent'>> {
  /** Test name, shown in vitest output. */
  name: string;
  /** Real AgentConfig, forwarded as-is to AgentExecutor.execute(). */
  agent: ExecuteOptions['agent'];
  /** Real input (string or Message[]), forwarded as-is. */
  input: ExecuteOptions['input'];
  /** Real LLMProvider instance, forwarded as-is. */
  provider: ExecuteOptions['provider'];
  // Every other ExecuteOptions field (toolRegistry, subagents, skills, hooks, maxSteps, temperature, ...) is forwarded as-is.
  /**
   * Scores the ExecutionResult from AgentExecutor.execute(). May be async
   * (e.g. an llmJudge()-based scorer that itself calls out to a provider).
   * Expected to return a number, conventionally in [0, 1] but the only
   * hard requirement is that it be comparable to `threshold`.
   */
  score: (result: ExecutionResult) => number | Promise<number>;
  /** Minimum score (inclusive) for the eval to pass. */
  threshold: number;
  /** Tags for `lousho eval --tag`. */
  tags?: string[];
  /** Per-case time limit in ms (0 = none); overrides `lousho eval --timeout` and the vitest config. */
  timeoutMs?: number;
}

/** Runs each case of a trajectory eval `repeat` times and passes it when `passAt` of the runs pass. */
export interface RepeatConfig {
  /** How many times to run each case (a model is not deterministic). The time limit covers all runs of a case. Default 1. */
  repeat?: number;
  /** Passes (pass@k) the case when at least this many of the `repeat` runs pass. Default: all of them. */
  passAt?: number;
}

/**
 * A trajectory eval (LOU-D7): `test(t, c)` sends messages to a real agent
 * and asserts on how it behaved. Runs once per entry of `cases`.
 *
 * @example
 * ```ts
 * defineEval({
 *   name: 'refund flow',
 *   agent,
 *   cases: [{ input: 'Refund order 42', tool: 'lookup_order' }],
 *   async test(t, c) {
 *     await t.send(c.input);
 *     t.completed();
 *     t.calledTool(c.tool);
 *   },
 * });
 * ```
 */
export interface TrajectoryEvalConfig<C = Record<string, never>> extends RepeatConfig {
  /** Eval name, shown in vitest and `lousho eval` output. */
  name: string;
  /**
   * The agent under test (from `createAgent()`), or a factory that builds a
   * fresh one per case so cases cannot share state. Use `mockModel` as its
   * provider for a deterministic CI eval.
   */
  agent?: AgentSource;
  /**
   * Run the cases against this instead of `agent`, e.g. `remoteTarget({ url })`
   * for a deployed agent. `lousho eval --url` overrides both.
   */
  target?: AgentSource;
  /** Tags for `lousho eval --tag`. */
  tags?: string[];
  /** Dataset: `test` runs once per case. A case's `label` (or `name`, or its `input`) names it in reports. */
  cases?: readonly C[];
  /** Judge provider for `t.judge()`. Without it `t.judge()` throws; no LLM is ever called implicitly. */
  judge?: EvalJudgeConfig;
  /**
   * Per-case time limit in ms (0 = none). Overrides `lousho eval --timeout`
   * and the vitest config's `testTimeout`; a case on a real model usually
   * needs far more than vitest's 5 s default.
   */
  timeoutMs?: number;
  /** The test body. Gate assertions fail the case; `t.soft()` ones are only reported. */
  test(t: EvalTestContext, c: C): void | Promise<void>;
}

const NO_CASE = {} as never;

/** A case's display label, and the untruncated one its cassette is named after. */
function caseLabel(c: unknown, index: number): { label: string; key: string } {
  const record = (typeof c === 'object' && c !== null ? c : {}) as Record<string, unknown>;
  for (const key of ['label', 'name']) {
    if (typeof record[key] === 'string') return { label: record[key] as string, key: record[key] as string };
  }
  if (typeof record.input === 'string') {
    const label = record.input.length > 48 ? `${record.input.slice(0, 45)}...` : record.input;
    return { label, key: record.input };
  }
  return { label: `case ${index + 1}`, key: `case ${index + 1}` };
}

function currentTestPath(expect: Pick<typeof Vitest, 'expect'>['expect']): string | undefined {
  try {
    return expect.getState().testPath;
  } catch {
    return undefined;
  }
}

/** What identifies one case to its report and its cassette. */
interface CaseRef {
  name: string;
  tags: string[];
  label?: string;
  key?: string;
  index?: number;
}

/** The vitest test context's `onTestFailed`, whose callback gets the task result (vitest 1-2) or the context (vitest 3+). */
type FailureHook = (fn: (arg: unknown) => void) => void;

function vitestErrorMessage(arg: unknown): string {
  const holder = arg as { errors?: unknown[]; task?: { result?: { errors?: unknown[] } } } | undefined;
  const first = (holder?.errors ?? holder?.task?.result?.errors)?.[0] as { message?: unknown } | undefined;
  const message = typeof first?.message === 'string' ? first.message : 'vitest failed the test';
  return /timed out/i.test(message)
    ? `${message} Raise the limit with defineEval({ timeoutMs }) or lousho eval --timeout <ms>.`
    : message;
}

/**
 * Runs `run` as one vitest test and records its result exactly once. When
 * vitest fails the test before the case finished (a timeout, mostly), an
 * error result is recorded instead, so `lousho eval` reports never miss the
 * case; the abandoned run's own result is then dropped.
 */
async function runCase(ref: CaseRef, file: string | undefined, context: unknown, run: () => Promise<EvalResult>): Promise<EvalResult> {
  const started = Date.now();
  let recorded = false;
  const record = (result: EvalResult) => {
    if (recorded) return;
    recorded = true;
    recordEvalResult(result);
  };
  (context as { onTestFailed?: FailureHook } | undefined)?.onTestFailed?.((arg) =>
    record({
      name: ref.name,
      ...(ref.label !== undefined ? { case: ref.label } : {}),
      tags: ref.tags,
      passed: false,
      assertions: [],
      durationMs: Date.now() - started,
      steps: 0,
      toolCalls: [],
      error: vitestErrorMessage(arg),
      file,
    })
  );
  const result = await withEvalCassettes({ file, name: ref.name, label: ref.label, key: ref.key, index: ref.index }, run);
  record(result);
  return result;
}

async function runTrajectory(config: TrajectoryEvalConfig<unknown>, c: unknown, ref: CaseRef, file: string | undefined, context: unknown): Promise<void> {
  const agent = remoteTargetFromEnv() ?? config.target ?? config.agent;
  const spec = { ...config, agent: agent ?? missingAgent };
  const times = repeatTimes(config.repeat);
  const needed = times === 1 ? 1 : passNeeded(config.passAt, times);
  const failures: string[] = [];
  for (let run = 1; run <= times; run++) {
    // Each repeat is its own report row and cassette.
    const runRef = times === 1 ? ref : { ...ref, label: `${ref.label ?? config.name} #${run}`, key: `${ref.key ?? config.name}#${run}` };
    const result = await runCase(runRef, file, context, () => runTrajectoryCase(spec, c, runRef.label, file));
    if (!result.passed) failures.push(describeFailure(result));
  }
  const passed = times - failures.length;
  if (passed >= needed) return;
  const summary = times === 1 ? '' : `passed ${passed} of ${times} runs, needed ${needed}.\n`;
  throw new SDKError(summary + failures.join('\n'),'LOUSHO_TEST_FAILED');
}

function repeatTimes(repeat: number | undefined): number {
  if (repeat === undefined) return 1;
  if (!Number.isInteger(repeat) || repeat < 1) throw new SDKError(`defineEval({ repeat }) must be a whole number of at least 1, got ${repeat}`, 'LOUSHO_EVALS_INVALID', { appendHelp: false });
  return repeat;
}

function passNeeded(passAt: number | undefined, times: number): number {
  if (passAt === undefined) return times;
  if (!Number.isInteger(passAt) || passAt < 1 || passAt > times) throw new SDKError(`defineEval({ passAt }) must be a whole number from 1 to repeat (${times}), got ${passAt}`, 'LOUSHO_EVALS_INVALID', { appendHelp: false });
  return passAt;
}

const missingAgent: AgentSource = () => {
  throw new SDKError("defineEval() needs an `agent` (or a `target`) to run the cases against", 'LOUSHO_CONFIG_MISSING_AGENT');
};

function defineTrajectoryEval(config: TrajectoryEvalConfig<unknown>): void {
  const { test, expect } = currentVitest();
  // expect.getState().testPath is only set while a test runs, not at collection.
  const file = () => currentTestPath(expect);
  const register = matchesTagFilter(config.tags ?? []) ? test : test.skip;
  const tags = config.tags ?? [];
  if (config.cases === undefined) {
    register(config.name, (context) => runTrajectory(config, NO_CASE, { name: config.name, tags }, file(), context), config.timeoutMs);
    return;
  }
  config.cases.forEach((c, index) => {
    const { label, key } = caseLabel(c, index);
    const ref = { name: config.name, tags, label, key, index };
    register(`${config.name} [${label}]`, (context) => runTrajectory(config, c, ref, file(), context), config.timeoutMs);
  });
}

/**
 * Returns the vitest API of the test run that is currently executing.
 *
 * This deliberately does NOT `import { test, expect } from 'vitest'`: this
 * module is re-exported from the package root, and that value import made
 * tsup bundle vitest itself into dist/index.js/.mjs, whose module-level
 * setup throws ("Vitest failed to access its internal state") as soon as
 * the SDK is imported anywhere outside a vitest worker - i.e. in every real
 * application (found by LOU-I7's docs snippet verification). Every vitest
 * worker exposes its own API as globalThis.__vitest_index__, which is also
 * exactly the instance the running test file registers with; with vitest
 * `globals` enabled, the global test/expect are used as a fallback.
 */
function currentVitest(): Pick<typeof Vitest, 'test' | 'expect'> {
  const g = globalThis as Record<string, unknown>;
  const api = g.__vitest_index__ as typeof Vitest | undefined;
  if (api && typeof api.test === 'function') return api;
  if (typeof g.test === 'function' && typeof g.expect === 'function') {
    return { test: g.test as typeof Vitest.test, expect: g.expect as typeof Vitest.expect };
  }
  throw new SDKError('defineEval() must be called from a test file running under vitest', 'LOUSHO_EVALS_INVALID');
}


function defineClassicEval(config: EvalConfig): void {
  const { name, score, threshold, tags, timeoutMs, ...executeFields } = config;
  const { test, expect } = currentVitest();
  const register = matchesTagFilter(tags ?? []) ? test : test.skip;

  register(name, async (context) => {
    if (remoteTargetFromEnv()) {
      throw new SDKError(`eval '${name}' is a score/threshold eval, which runs an in-process provider and cannot run with --url; use a trajectory eval`, 'LOUSHO_CONFIG_CONFLICTING_OPTIONS');
    }
    const file = currentTestPath(expect);
    const evalResult = await runCase({ name, tags: tags ?? [] }, file, context, async () => {
      const started = Date.now();
      const nested: NestedCall[] = [];
      const result = await AgentExecutor.execute({ ...executeFields, onAgentEvent: (event) => collectNested(event, nested) });
      const assertion = scoreAssertion(await score(result), threshold);
      return {
        name,
        tags: tags ?? [],
        passed: assertion.passed,
        assertions: [assertion],
        durationMs: Date.now() - started,
        steps: result.steps,
        toolCalls: mergeNested(result.toolCalls ?? [], nested),
        usage: result.usage,
        file,
      };
    });
    expect(evalResult.assertions[0].score).toBeGreaterThanOrEqual(threshold);
  }, timeoutMs);
}

/**
 * Define an eval as vitest test(s). Two forms:
 *
 * - Classic: `{ name, agent, input, provider, score, threshold }` calls
 *   AgentExecutor.execute() once, scores the result and asserts
 *   `score >= threshold`.
 * - Trajectory: `{ name, agent, cases?, test(t, c) }` drives a
 *   `createAgent()` agent and asserts on its tool calls, steps and reply.
 *
 * Run evals with `lousho eval` for a summary table and JUnit/JSON reports.
 *
 * @example
 * ```ts
 * defineEval({
 *   name: 'greets',
 *   agent: createAgent({ provider: mockModel(['Hello!']) }),
 *   async test(t) {
 *     await t.send('hi');
 *     t.completed();
 *     t.check('greets', t.reply, includes('Hello'));
 *   },
 * });
 * ```
 */
export function defineEval(config: EvalConfig): void;
export function defineEval<C = Record<string, never>>(config: TrajectoryEvalConfig<C>): void;
export function defineEval(config: EvalConfig | TrajectoryEvalConfig<unknown>): void {
  if ('test' in config) defineTrajectoryEval(config);
  else defineClassicEval(config);
}
