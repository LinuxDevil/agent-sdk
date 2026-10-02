/**
 * llmJudge() rubric grading helper (LOU-G6)
 *
 * Builds a grading prompt from a rubric and the agent run's output text,
 * sends it through the REAL LLMProvider interface's generate() method
 * (src/providers/llm.ts - LLMProvider only has generate()/stream(), both
 * taking a GenerateOptions with a `messages` array; there is no
 * `.complete(prompt: string)` method), and parses the response into a
 * clamped [0, 1] score.
 */

import { LLMProvider } from '../providers/llm';
import { ExecutionResult } from '../execution/AgentExecutor';
import { SDKError } from '../execution/errors';

export interface LLMJudgeConfig {
  /** Real LLMProvider instance used to grade the output. */
  provider: LLMProvider;
  /** Model id passed through to provider.generate(). */
  model: string;
  /** Grading rubric / instructions shown to the judge model. */
  rubric: string;
  temperature?: number;
  /**
   * Skip the "only inside the judge-eval runner" guard. `t.judge()` sets this
   * because the judge provider was configured explicitly on the eval.
   */
  allowOutsideJudgeRunner?: boolean;
}

/**
 * Builds the grading prompt sent to the judge model.
 */
function buildGradePrompt(rubric: string, outputText: string): string {
  return [
    'You are grading the output of an AI agent against a rubric.',
    'Respond with ONLY a single number between 0 and 1 (inclusive), representing how well the output satisfies the rubric.',
    'Do not include any explanation, units, or extra text - just the number.',
    '',
    `Rubric:\n${rubric}`,
    '',
    `Agent output to grade:\n${outputText}`,
  ].join('\n');
}

/**
 * Parses a judge model's raw text response into a score clamped to [0, 1].
 * A malformed (non-numeric) response is handled explicitly - it returns 0
 * with a reason, rather than letting `parseFloat` produce NaN and relying
 * on NaN's comparisons always being false in `expect(score).toBeGreaterThanOrEqual(threshold)`
 * to accidentally fail closed.
 */
export function parseJudgeScore(rawText: string): { score: number; reason?: string } {
  const trimmed = rawText.trim();
  const parsed = parseFloat(trimmed);

  if (Number.isNaN(parsed)) {
    return { score: 0, reason: `judge response was not a number: ${JSON.stringify(rawText)}` };
  }

  const clamped = Math.min(1, Math.max(0, parsed));
  return { score: clamped };
}

/**
 * Returns a defineEval()-compatible scorer that grades an ExecutionResult's
 * `.text` against `config.rubric` using an LLM judge, via
 * provider.generate({ messages: [...] }) (NOT a bare-string `.complete()`,
 * which this codebase's LLMProvider interface does not have).
 */
export function llmJudge(config: LLMJudgeConfig): (result: ExecutionResult) => Promise<number> {
  return async (result: ExecutionResult): Promise<number> => {
    // Structural guard, independent of file-naming conventions: this env var
    // is only set by vitest.judge.config.ts. A *.eval.ts file that imports
    // llmJudge() but is accidentally picked up by the main vitest run (e.g.
    // a misnamed or mis-globbed file) fails loudly here instead of silently
    // making a real, budgeted LLM call as part of default/CI test runs.
    if (!config.allowOutsideJudgeRunner && process.env.LOUSHO_ALLOW_LLM_JUDGE !== '1') {
      throw new SDKError(
        'llmJudge() was invoked outside the judge-eval runner. ' +
          'llmJudge()-based evals must live in a "*.judge.eval.ts" file and run via ' +
          '`npm run test:evals:judge` (vitest.judge.config.ts), never the default `vitest run`.',
        'LOUSHO_EVALS_INVALID'
      );
    }

    const gradePrompt = buildGradePrompt(config.rubric, result.text ?? '');

    const response = await config.provider.generate({
      model: config.model,
      messages: [{ role: 'user', content: gradePrompt }],
      temperature: config.temperature,
    });

    const { score } = parseJudgeScore(response.text);
    return score;
  };
}
