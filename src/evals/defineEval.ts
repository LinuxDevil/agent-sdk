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

import { test, expect } from 'vitest';
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
 * Define a single eval as a vitest test. Calls AgentExecutor.execute()
 * exactly once with the config's execution fields, scores the result, and
 * asserts `score >= threshold`.
 */
export function defineEval(config: EvalConfig): void {
  const { name, score, threshold, ...executeFields } = config;

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
