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
import { textOf } from '../providers/content';

export interface LLMJudgeConfig {
  /** Real LLMProvider instance used to grade the output. */
  provider: LLMProvider;
  /** Model id passed through to provider.generate(). Defaults to the provider's own model. */
  model?: string;
  /** Grading rubric / instructions shown to the judge model. */
  rubric: string;
  /** Sampling temperature for the judge call. Defaults to 0 so a grade is repeatable. */
  temperature?: number;
  /**
   * Skip the "only inside the judge-eval runner" guard. `t.judge()` sets this
   * because the judge provider was configured explicitly on the eval.
   */
  allowOutsideJudgeRunner?: boolean;
}

/** The text of the latest user message in the run, i.e. what the agent was asked. */
function userInputOf(result: ExecutionResult): string {
  const messages = result.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return textOf(messages[i]);
  }
  return '';
}

/** The rubric, the user's request and the agent output, in the order the judge reads them. */
function gradeBody(rubric: string, input: string, outputText: string): string[] {
  return [
    `Rubric:\n${rubric}`,
    '',
    ...(input ? [`User input the agent was answering:\n${input}`, ''] : []),
    `Agent output to grade:\n${outputText}`,
  ];
}

/**
 * Builds the grading prompt sent to the judge model. The judge may reason
 * first; the grade is the LAST `SCORE: <0..1>` line (see parseJudgeScore).
 */
function buildGradePrompt(rubric: string, input: string, outputText: string): string {
  return [
    'You are grading the output of an AI agent against a rubric.',
    'You may explain your reasoning briefly. Your LAST line must be exactly `SCORE: <a single number between 0 and 1 (inclusive)>`, for how well the output satisfies the rubric.',
    '',
    ...gradeBody(rubric, input, outputText),
  ].join('\n');
}

/**
 * Builds the critique prompt sent to the judge model: the same grading
 * task as buildGradePrompt(), but the requested response format is a
 * SCORE line plus a FEEDBACK line, so revision loops get the critic's
 * fix-it note in the same provider call as the score.
 */
function buildCritiquePrompt(rubric: string, input: string, outputText: string): string {
  return [
    'You are grading the output of an AI agent against a rubric.',
    'Respond with exactly two lines, in this order:',
    'SCORE: <a single number between 0 and 1 (inclusive), for how well the output satisfies the rubric>',
    'FEEDBACK: <the single most important fix the author should make on revision; "none" if the output fully satisfies the rubric>',
    '',
    ...gradeBody(rubric, input, outputText),
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
    temperature: config.temperature ?? 0,
  });
  return response.text;
}

const NUMBER = '(-?\\d+(?:\\.\\d+)?|-?\\.\\d+)';
const SUFFIX = '\\s*(?:(?:\\/|out\\s+of)\\s*(\\d+(?:\\.\\d+)?)|(%))?';
/** A score right after a `score`/`rating`/`grade` label (`Score: 0.9`, `**Score** = 8/10`, `"score": 0.8`). */
const LABELLED_PATTERN = new RegExp(`\\b(?:scores?|rating|grade)\\b\\W{0,6}?${NUMBER}${SUFFIX}`, 'gi');
/** A response that is nothing but one number (`0.9`, `**0.9**`, `85%`, `8/10`). */
const BARE_PATTERN = new RegExp(`^[\\s*_\\x60]*${NUMBER}${SUFFIX}[\\s*_\\x60.]*$`, 'i');

/** The [0, 1] value one score match stands for. */
function scaleScore(match: RegExpMatchArray): number {
  const value = parseFloat(match[1]);
  if (match[2] !== undefined) return parseFloat(match[2]) > 0 ? value / parseFloat(match[2]) : 0;
  if (match[3] !== undefined) return value / 100;
  // A bare whole number above 1 is a score out of 10 (`8`) or out of 100 (`85`).
  if (Number.isInteger(value) && value > 1 && value <= 10) return value / 10;
  if (Number.isInteger(value) && value > 10 && value <= 100) return value / 100;
  return value;
}

/**
 * Parses a judge model's raw text response into a score clamped to [0, 1].
 * The LAST `score`-labelled number wins (`SCORE: 0.9`, `**Score:** 8/10`,
 * `{"score": 0.8}`), so reasoning that mentions other numbers ("1 of 5
 * criteria ... Score: 0.2") cannot be misread. Without a label the whole
 * response must be a single number (`0.9`, `**0.9**`, `85%`); any other
 * unlabelled prose is unparseable. `8/10`, `8 out of 10`, `85%` and bare
 * whole numbers 2-100 (`8` is 8/10, `85` is 85/100) are scaled into [0, 1].
 * An unparseable response returns 0 with a reason, rather than letting
 * `parseFloat` produce NaN and relying on NaN's comparisons always being
 * false in `expect(score).toBeGreaterThanOrEqual(threshold)` to
 * accidentally fail closed.
 */
export function parseJudgeScore(rawText: string): { score: number; reason?: string } {
  const labelled = [...rawText.matchAll(LABELLED_PATTERN)];
  const match = labelled.length > 0 ? labelled[labelled.length - 1] : BARE_PATTERN.exec(rawText);

  if (!match) {
    return { score: 0, reason: `judge response was not a number: ${JSON.stringify(rawText)}` };
  }

  const clamped = Math.min(1, Math.max(0, scaleScore(match)));
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
  const scoreLines = [...rawText.matchAll(/^\s*SCORE:[^\n]*$/gim)];
  const scoreMatch = scoreLines.length > 0 ? scoreLines[scoreLines.length - 1] : null;
  const feedbackMatch = /^\s*FEEDBACK:\s*([\s\S]*)$/im.exec(rawText);

  const { score, reason } = scoreMatch ? parseJudgeScore(scoreMatch[0]) : parseJudgeScore(rawText);

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

    const responseText = await generateJudgeResponse(config, buildGradePrompt(config.rubric, userInputOf(result), result.text ?? ''));

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

    const responseText = await generateJudgeResponse(config, buildCritiquePrompt(config.rubric, userInputOf(result), result.text ?? ''));

    return parseJudgeCritique(responseText);
  };
}
