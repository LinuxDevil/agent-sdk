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

/**
 * Define a single eval as a vitest test. Calls AgentExecutor.execute()
 * exactly once with the config's execution fields, scores the result, and
 * asserts `score >= threshold`.
 */
export function defineEval(config: EvalConfig): void {
  const { name, score, threshold, ...executeFields } = config;
  const { test, expect } = currentVitest();

  test(name, async () => {
    const result = await AgentExecutor.execute({
      agent: executeFields.agent,
      input: executeFields.input,
      provider: executeFields.provider,
      toolRegistry: executeFields.toolRegistry,
      maxSteps: executeFields.maxSteps,
      temperature: executeFields.temperature,
      maxTokens: executeFields.maxTokens,
    });

    const resultScore = await score(result);

    expect(resultScore).toBeGreaterThanOrEqual(threshold);
  });
}
