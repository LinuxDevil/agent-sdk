/**
 * llmJudge() / llmCritique() rubric grading helpers (LOU-G6)
 *
 * Builds a grading prompt from a rubric and the agent run's output text,
 * sends it through the REAL LLMProvider interface's generate() method
 * (src/providers/llm.ts - LLMProvider only has generate()/stream(), both
 * taking a GenerateOptions with a `messages` array; there is no
 * `.complete(prompt: string)` method), and parses the response into a
 * clamped [0, 1] score.
 *
 * llmCritique() is the revision-loop sibling: an llmJudge() scorer
 * resolves to a bare number, so evaluator-optimizer loops could never
 * reach the judge's textual feedback. llmCritique() asks for a SCORE
 * line plus a FEEDBACK line in ONE provider.generate() call and resolves
 * to `{ score, feedback }`.
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
 * Builds the critique prompt sent to the judge model: the same grading
 * task as buildGradePrompt(), but the requested response format is a
 * SCORE line plus a FEEDBACK line, so revision loops get the critic's
 * fix-it note in the same provider call as the score.
 */
function buildCritiquePrompt(rubric: string, outputText: string): string {
  return [
    'You are grading the output of an AI agent against a rubric.',
    'Respond with exactly two lines, in this order:',
    'SCORE: <a single number between 0 and 1 (inclusive), for how well the output satisfies the rubric>',
    'FEEDBACK: <the single most important fix the author should make on revision; "none" if the output fully satisfies the rubric>',
    '',
    `Rubric:\n${rubric}`,
    '',
    `Agent output to grade:\n${outputText}`,
  ].join('\n');
}

/**
 * The structural guard llmJudge() and llmCritique() share, independent of
 * file-naming conventions: this env var is only set by
 * vitest.judge.config.ts. A *.eval.ts file that imports either helper but
 * is accidentally picked up by the main vitest run (e.g. a misnamed or
 * mis-globbed file) fails loudly here instead of silently making a real,
 * budgeted LLM call as part of default/CI test runs.
 */
function assertInsideJudgeRunner(config: LLMJudgeConfig, helper: string): void {
  if (!config.allowOutsideJudgeRunner && process.env.LOUSHO_ALLOW_LLM_JUDGE !== '1') {
    throw new SDKError(
      `${helper} was invoked outside the judge-eval runner. ` +
        `${helper}-based evals must live in a "*.judge.eval.ts" file and run via ` +
        '`npm run test:evals:judge` (vitest.judge.config.ts), never the default `vitest run`.',
      'LOUSHO_EVALS_INVALID'
    );
  }
}

/**
 * Sends one prompt through the judge provider and returns its raw text.
 */
async function generateJudgeResponse(config: LLMJudgeConfig, prompt: string): Promise<string> {
  const response = await config.provider.generate({
    model: config.model,
    messages: [{ role: 'user', content: prompt }],
    temperature: config.temperature,
  });
  return response.text;
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
 * What a judge model's response to the critique prompt parses into: the
 * same clamped [0, 1] score llmJudge() returns, plus the critic's
 * revision note.
 */
export interface LLMCritique {
  /** Judge's score, clamped to [0, 1]. */
  score: number;
  /** The judge's actionable fix for the next draft; '' when the response carried none. */
  feedback: string;
  /** Why the response was treated as malformed, when it was (see parseJudgeScore). */
  reason?: string;
}

/**
 * Parses a judge model's raw response to the critique prompt into an
 * LLMCritique. The explicit `SCORE:`/`FEEDBACK:` markers are preferred,
 * but judges do not always follow the format, so both halves degrade
 * gracefully: a missing SCORE marker falls back to parseJudgeScore()
 * (bare-number responses still work), and a missing FEEDBACK marker
 * treats whatever non-score prose remains as the feedback. A fully
 * malformed response scores 0 with a reason, like parseJudgeScore().
 */
export function parseJudgeCritique(rawText: string): LLMCritique {
  const scoreMatch = /^\s*SCORE:\s*([^\n]*)$/im.exec(rawText);
  const feedbackMatch = /^\s*FEEDBACK:\s*([\s\S]*)$/im.exec(rawText);

  const { score, reason } = scoreMatch ? parseJudgeScore(scoreMatch[1]) : parseJudgeScore(rawText);

  let feedback = '';
  if (feedbackMatch) {
    // Everything after the FEEDBACK: marker is the note - SCORE comes
    // first in the requested format, so following lines belong to it.
    // A stray trailing SCORE line (judge emitted the lines out of
    // order) is stripped rather than leaked into the feedback.
    feedback = feedbackMatch[1].replace(/\n\s*SCORE:[^\n]*$/i, '').trim();
  } else {
    // No marker: a bare score leaves no feedback; otherwise the prose
    // that isn't the SCORE line is the best feedback available.
    const prose = rawText.replace(/^\s*SCORE:[^\n]*$/gim, '').trim();
    feedback = Number.isNaN(parseFloat(prose)) ? prose : '';
  }

  return reason === undefined ? { score, feedback } : { score, feedback, reason };
}

/**
 * Returns a defineEval()-compatible scorer that grades an ExecutionResult's
 * `.text` against `config.rubric` using an LLM judge, via
 * provider.generate({ messages: [...] }) (NOT a bare-string `.complete()`,
 * which this codebase's LLMProvider interface does not have).
 */
export function llmJudge(config: LLMJudgeConfig): (result: ExecutionResult) => Promise<number> {
  return async (result: ExecutionResult): Promise<number> => {
    assertInsideJudgeRunner(config, 'llmJudge()');

    const responseText = await generateJudgeResponse(config, buildGradePrompt(config.rubric, result.text ?? ''));

    const { score } = parseJudgeScore(responseText);
    return score;
  };
}

/**
 * The revision-loop sibling of llmJudge(): same LLMJudgeConfig, same
 * outside-the-judge-runner guard, but one provider.generate() call
 * resolves to `{ score, feedback }` - the critic's fix-it note a failing
 * draft carries into the writer's next turn, which a bare-number scorer
 * cannot express. Use it for evaluator-optimizer loops; keep llmJudge()
 * for plain eval scoring.
 */
export function llmCritique(config: LLMJudgeConfig): (result: ExecutionResult) => Promise<LLMCritique> {
  return async (result: ExecutionResult): Promise<LLMCritique> => {
    assertInsideJudgeRunner(config, 'llmCritique()');

    const responseText = await generateJudgeResponse(config, buildCritiquePrompt(config.rubric, result.text ?? ''));

    return parseJudgeCritique(responseText);
  };
}
