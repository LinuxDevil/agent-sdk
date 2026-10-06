/**
 * evaluator-loop - the evaluator-optimizer pattern from Anthropic's
 * agentic taxonomy ("Building effective agents"): a writer agent produces
 * a draft, an evaluator scores it against a rubric, and a failing draft
 * loops back to the writer - carrying the critic's feedback - until the
 * score passes or the round budget runs out. This is the writer/critic
 * shape CrewAI-style content pipelines use.
 *
 * The evaluator is `llmCritique()` (src/evals/llmJudge.ts), the
 * revision-loop sibling of `llmJudge()`: an llmJudge() scorer resolves
 * to a bare number, while llmCritique() asks the judge for a SCORE line
 * plus a FEEDBACK line in one provider.generate() call and resolves to
 * `{ score, feedback }` - so the critic's note reaches the writer's next
 * turn with no second provider call.
 *
 * Offline (the default) the writer is a scripted mock whose first draft
 * fails on citations and whose revision passes; the judge is scripted too.
 * With OPENROUTER_API_KEY set, writer and judge both run live on
 * openrouter/openai/gpt-4o-mini.
 *
 * Run with: npx tsx examples/evaluator-loop/index.ts
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createAgent,
  llmCritique,
  resolveProvider,
  type LLMJudgeConfig,
  type SimpleAgent,
} from '../../src';
import { mockModel } from '../../src/testing';

export const LIVE_MODEL = 'openrouter/openai/gpt-4o-mini';
/** Bare model id, as `judge.provider.generate({ model })` expects it. */
const LIVE_JUDGE_MODEL = 'openai/gpt-4o-mini';

/**
 * The rubric the judge's critique prompt grades against.
 */
export const RUBRIC = [
  'Grade the product description on three criteria:',
  '- clear: a buyer understands it immediately;',
  '- accurate: it makes no unverifiable claims;',
  '- cited: it names a source or spec for each factual claim.',
].join('\n');

const DEMO_PROMPT =
  'Write a 3-sentence product description for HydraTrack, a smart water bottle.';

export interface EvaluatorLoopOptions {
  /**
   * The drafting agent (from `createAgent()`). Every round is a turn of
   * one session, so revision prompts can reference "your draft" and the
   * earlier text stays in context.
   */
  writer: SimpleAgent;
  /**
   * The evaluator: provider + model + rubric, in `llmJudge()`'s own
   * config shape (`llmCritique()` takes the same LLMJudgeConfig). One
   * judge call per round returns both the score and the critic's note.
   */
  judge: LLMJudgeConfig;
  /** The writing task the writer's first turn receives. */
  prompt: string;
  /** Score at or above which the loop stops early, in [0, 1]. */
  passScore: number;
  /** How many draft-score-revise rounds to run before returning the last draft. */
  maxRounds: number;
}

export interface EvaluatorRound {
  /** 1-based round number. */
  round: number;
  /** The draft the writer produced this round. */
  text: string;
  /** The judge's score for it, in [0, 1]. */
  score: number;
  /**
   * The critic's fix-it note, fed to the writer's next turn. Set only on
   * failing rounds that were followed by a revision - a passing draft and
   * a final-round failure have none.
   */
  feedback?: string;
}

export interface EvaluatorLoopResult {
  /** The last draft - the passing one when the loop broke early. */
  text: string;
  /** Its score. */
  score: number;
  /** How many rounds ran (1..maxRounds). */
  rounds: number;
  /** Every round, in order: draft, score, and the feedback it produced. */
  history: EvaluatorRound[];
}

/**
 * Runs the evaluator-optimizer loop: `prompt` goes to the writer, each
 * draft is judged by `llmCritique()`, and a draft under `passScore` is
 * sent back to the writer's session together with the critic's feedback.
 * The loop stops on the first passing score or after `maxRounds` drafts.
 */
export async function runEvaluatorLoop(options: EvaluatorLoopOptions): Promise<EvaluatorLoopResult> {
  const { writer, judge, prompt, passScore, maxRounds } = options;
  if (maxRounds < 1) throw new Error('runEvaluatorLoop: maxRounds must be >= 1');
  if (passScore < 0 || passScore > 1) throw new Error('runEvaluatorLoop: passScore must be in [0, 1]');

  // llmCritique() carries llmJudge()'s guard against being swept into the
  // default `vitest run` via a mis-named *.judge.eval.ts file
  // (LOUSHO_ALLOW_LLM_JUDGE). This loop runs it as ordinary library code,
  // so opt out of the runner guard unless the caller already chose.
  const critic = llmCritique({ ...judge, allowOutsideJudgeRunner: judge.allowOutsideJudgeRunner ?? true });

  const session = writer.session();
  const history: EvaluatorRound[] = [];

  for (let round = 1; round <= maxRounds; round++) {
    const result = await session.send(roundInput(prompt, history.at(-1), passScore));
    const { score, feedback: note } = await critic(result);
    const passed = score >= passScore;
    // No revision follows a passing score or the final round, so the
    // judge's note is only kept on failing rounds another turn follows.
    const feedback = passed || round === maxRounds || !note ? undefined : note;
    history.push({ round, text: result.text, score, ...(feedback !== undefined ? { feedback } : {}) });
    if (passed) break;
  }

  const last = history[history.length - 1];
  return { text: last.text, score: last.score, rounds: history.length, history };
}

/** The opening prompt on round one, then a revision request quoting the last score and feedback. */
function roundInput(prompt: string, previous: EvaluatorRound | undefined, passScore: number): string {
  if (previous === undefined) return prompt;
  return [
    `Your draft scored ${previous.score.toFixed(2)} against the rubric (passing: ${passScore}).`,
    previous.feedback ? `Critic feedback: ${previous.feedback}` : 'The critic gave no actionable feedback.',
    'Revise the draft to address the feedback.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Offline scripts: a weak draft, a critique, a revision that passes.
// ---------------------------------------------------------------------------

/** The writer's two drafts; turn 2 is the revision after the critique. */
export function scriptedWriter() {
  return mockModel([
    { text: 'HydraTrack is the best smart water bottle ever made. It keeps water cold. You will love it.' },
    // The revision turn: the rewrite the writer produces once the critic's
    // note lands in its session. (A function turn could read the note off
    // the incoming request instead.)
    {
      text:
        'HydraTrack chills water to 4°C for 24 hours, per the maker\'s ISO 22000 test report. ' +
        'Its cap logs each sip and syncs totals to the companion app. ' +
        "It sells for $49 (maker's listed price).",
    },
  ]);
}

/** The judge: a failing score+note, then a passing score. */
export function scriptedJudge() {
  return mockModel([
    'SCORE: 0.42\nFEEDBACK: Cite a source for each factual claim and drop the unverifiable "best ever".',
    'SCORE: 0.91\nFEEDBACK: none',
  ]);
}

async function main() {
  const live = Boolean(process.env.OPENROUTER_API_KEY);
  const writer = createAgent({
    name: 'writer',
    instructions: 'You write short product copy. When a critic gives feedback, revise the draft to address it.',
    ...(live ? { model: LIVE_MODEL } : { provider: scriptedWriter() }),
  });
  const judge: LLMJudgeConfig = live
    ? { provider: resolveProvider(LIVE_MODEL), model: LIVE_JUDGE_MODEL, rubric: RUBRIC, temperature: 0 }
    : { provider: scriptedJudge(), model: 'mock-judge', rubric: RUBRIC };

  console.log(live ? `Live run on ${LIVE_MODEL}` : 'Offline run with scripted models');
  const result = await runEvaluatorLoop({
    writer,
    judge,
    prompt: DEMO_PROMPT,
    passScore: 0.8,
    maxRounds: 3,
  });

  for (const round of result.history) {
    console.log(`\n--- round ${round.round} | score ${round.score.toFixed(2)} ---`);
    console.log(round.text);
    if (round.feedback) console.log(`  critic: ${round.feedback}`);
  }
  console.log(
    `\n${result.score >= 0.8 ? 'PASSED' : 'MAX ROUNDS REACHED'} after ${result.rounds} round(s), final score ${result.score.toFixed(2)}`
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
