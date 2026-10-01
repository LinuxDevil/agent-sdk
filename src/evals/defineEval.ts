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
import { scoreAssertion } from './evalResult';
import { matchesTagFilter, recordEvalResult } from './recorder';
import { remoteTargetFromEnv } from './remoteTarget';
import { SDKError } from '../execution/errors';
import { parseToolCalls } from './toolMatch';
import {
  describeFailure,
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
export interface EvalConfig {
  /** Test name, shown in vitest output. */
  name: string;
  /** Real AgentConfig, forwarded as-is to AgentExecutor.execute(). */
  agent: ExecuteOptions['agent'];
  /** Real input (string or Message[]), forwarded as-is. */
  input: ExecuteOptions['input'];
  /** Real LLMProvider instance, forwarded as-is. */
  provider: ExecuteOptions['provider'];
  /** Optional ToolRegistry, forwarded as-is. */
  toolRegistry?: ExecuteOptions['toolRegistry'];
  maxSteps?: ExecuteOptions['maxSteps'];
  temperature?: ExecuteOptions['temperature'];
  maxTokens?: ExecuteOptions['maxTokens'];
  /**
   * Scores the ExecutionResult from AgentExecutor.execute(). May be async
   * (e.g. an llmJudge()-based scorer that itself calls out to a provider).
   * Expected to return a number, conventionally in [0, 1] but the only
   * hard requirement is that it be comparable to `threshold`.
   */
  score: (result: ExecutionResult) => number | Promise<number>;
  /** Minimum score (inclusive) for the eval to pass. */
  threshold: number;
  /** Tags for `loushy eval --tag`. */
  tags?: string[];
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
export interface TrajectoryEvalConfig<C = Record<string, never>> {
  /** Eval name, shown in vitest and `loushy eval` output. */
  name: string;
  /**
   * The agent under test (from `createAgent()`), or a factory that builds a
   * fresh one per case so cases cannot share state. Use `mockModel` as its
   * provider for a deterministic CI eval.
   */
  agent?: AgentSource;
  /**
   * Run the cases against this instead of `agent`, e.g. `remoteTarget({ url })`
   * for a deployed agent. `loushy eval --url` overrides both.
   */
  target?: AgentSource;
  /** Tags for `loushy eval --tag`. */
  tags?: string[];
  /** Dataset: `test` runs once per case. A case's `label` (or `name`, or its `input`) names it in reports. */
  cases?: readonly C[];
  /** Judge provider for `t.judge()`. Without it `t.judge()` throws; no LLM is ever called implicitly. */
  judge?: EvalJudgeConfig;
  /** The test body. Gate assertions fail the case; `t.soft()` ones are only reported. */
  test(t: EvalTestContext, c: C): void | Promise<void>;
}

const NO_CASE = {} as never;

function caseLabel(c: unknown, index: number): string {
  const record = (typeof c === 'object' && c !== null ? c : {}) as Record<string, unknown>;
  for (const key of ['label', 'name']) {
    if (typeof record[key] === 'string') return record[key] as string;
  }
  if (typeof record.input === 'string') {
    return record.input.length > 48 ? `${record.input.slice(0, 45)}...` : record.input;
  }
  return `case ${index + 1}`;
}

function currentTestPath(expect: Pick<typeof Vitest, 'expect'>['expect']): string | undefined {
  try {
    return expect.getState().testPath;
  } catch {
    return undefined;
  }
}

async function runAndReport(
  config: TrajectoryEvalConfig<unknown>,
  c: unknown,
  label: string | undefined,
  file: string | undefined
): Promise<void> {
  const agent = remoteTargetFromEnv() ?? config.target ?? config.agent;
  const spec = { ...config, agent: agent ?? missingAgent };
  const result = await withEvalCassettes({ file, name: config.name, label }, () => runTrajectoryCase(spec, c, label, file));
  recordEvalResult(result);
  if (!result.passed) throw new Error(describeFailure(result));
}

const missingAgent: AgentSource = () => {
  throw new SDKError("defineEval() needs an `agent` (or a `target`) to run the cases against", 'LOUSHY_CONFIG_MISSING_AGENT');
};

function defineTrajectoryEval(config: TrajectoryEvalConfig<unknown>): void {
  const { test, expect } = currentVitest();
  // expect.getState().testPath is only set while a test runs, not at collection.
  const file = () => currentTestPath(expect);
  const register = matchesTagFilter(config.tags ?? []) ? test : test.skip;
  if (config.cases === undefined) {
    register(config.name, () => runAndReport(config, NO_CASE, undefined, file()));
    return;
  }
  config.cases.forEach((c, index) => {
    const label = caseLabel(c, index);
    register(`${config.name} [${label}]`, () => runAndReport(config, c, label, file()));
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
  throw new Error('defineEval() must be called from a test file running under vitest');
}


function defineClassicEval(config: EvalConfig): void {
  const { name, score, threshold, tags, ...executeFields } = config;
  const { test, expect } = currentVitest();
  const register = matchesTagFilter(tags ?? []) ? test : test.skip;

  register(name, async () => {
    if (remoteTargetFromEnv()) {
      throw new SDKError(`eval '${name}' is a score/threshold eval, which runs an in-process provider and cannot run with --url; use a trajectory eval`, 'LOUSHY_CONFIG_CONFLICTING_OPTIONS');
    }
    const file = currentTestPath(expect);
    const evalResult = await withEvalCassettes({ file, name }, async () => {
      const started = Date.now();
      const result = await AgentExecutor.execute({
        agent: executeFields.agent,
        input: executeFields.input,
        provider: executeFields.provider,
        toolRegistry: executeFields.toolRegistry,
        maxSteps: executeFields.maxSteps,
        temperature: executeFields.temperature,
        maxTokens: executeFields.maxTokens,
      });
      const assertion = scoreAssertion(await score(result), threshold);
      return {
        name,
        tags: tags ?? [],
        passed: assertion.passed,
        assertions: [assertion],
        durationMs: Date.now() - started,
        steps: result.steps,
        toolCalls: parseToolCalls(result.toolCalls ?? []),
        usage: result.usage,
        file,
      };
    });
    recordEvalResult(evalResult);

    expect(evalResult.assertions[0].score).toBeGreaterThanOrEqual(threshold);
  });
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
 * Run evals with `loushy eval` for a summary table and JUnit/JSON reports.
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
