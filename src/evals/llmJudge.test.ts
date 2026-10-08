import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseJudgeScore, parseJudgeCritique, llmJudge, llmCritique } from './llmJudge';
import type { LLMProvider } from '../providers/llm';

describe('parseJudgeScore', () => {
  it('parses a well-formed numeric response', () => {
    expect(parseJudgeScore('0.9')).toEqual({ score: 0.9 });
    expect(parseJudgeScore('1')).toEqual({ score: 1 });
    expect(parseJudgeScore('  0.5  ')).toEqual({ score: 0.5 });
  });

  it('clamps out-of-range numeric responses into [0, 1]', () => {
    expect(parseJudgeScore('1.5').score).toBe(1);
    expect(parseJudgeScore('-0.3').score).toBe(0);
  });

  it('returns 0 with a clear reason for a malformed, non-numeric response, instead of letting NaN through', () => {
    const { score, reason } = parseJudgeScore('the output looks great');

    // Explicitly verify this is a real 0, not a NaN that happens to fail
    // `>= threshold` comparisons (NaN comparisons are always false in JS,
    // which would already "fail safe" - but that's accidental, not
    // intentional, so we assert the actual numeric value here).
    expect(score).toBe(0);
    expect(Number.isNaN(score)).toBe(false);
    expect(reason).toBeDefined();
    expect(reason).toContain('the output looks great');
  });

  it('reads a labelled or decorated score, not just a bare number (docs-qa F12)', () => {
    expect(parseJudgeScore('Score: 0.9').score).toBe(0.9);
    expect(parseJudgeScore('**0.9**').score).toBe(0.9);
    expect(parseJudgeScore('The answer is grounded.\n\n**Score:** 0.75').score).toBe(0.75);
    expect(parseJudgeScore('Score: -0.3').score).toBe(0);
  });

  it('scales N/10, N out of 10, percentages and bare whole numbers out of 10 or 100 into [0, 1]', () => {
    expect(parseJudgeScore('9/10').score).toBe(0.9);
    expect(parseJudgeScore('7 out of 10').score).toBe(0.7);
    expect(parseJudgeScore('Rating: 4/5').score).toBe(0.8);
    expect(parseJudgeScore('85%').score).toBe(0.85);
    expect(parseJudgeScore('Score: 8').score).toBe(0.8);
    expect(parseJudgeScore('85').score).toBe(0.85);
    expect(parseJudgeScore('10').score).toBe(1);
    expect(parseJudgeScore('250').score).toBe(1);
  });

  it('treats an empty response the same as a malformed one', () => {
    const { score, reason } = parseJudgeScore('');
    expect(score).toBe(0);
    expect(reason).toBeDefined();
  });
});

describe('parseJudgeCritique', () => {
  it('parses the requested SCORE/FEEDBACK format', () => {
    expect(parseJudgeCritique('SCORE: 0.4\nFEEDBACK: add citations')).toEqual({
      score: 0.4,
      feedback: 'add citations',
    });
  });

  it('keeps multi-line feedback after the FEEDBACK marker', () => {
    const { score, feedback } = parseJudgeCritique(
      'SCORE: 0.5\nFEEDBACK: tighten the opening.\nAdd a citation for each claim.'
    );
    expect(score).toBe(0.5);
    expect(feedback).toBe('tighten the opening.\nAdd a citation for each claim.');
  });

  it('clamps a marked-up out-of-range score into [0, 1]', () => {
    expect(parseJudgeCritique('SCORE: 1.4\nFEEDBACK: none').score).toBe(1);
    expect(parseJudgeCritique('SCORE: -0.2\nFEEDBACK: none').score).toBe(0);
  });

  it('still scores a bare-number response, with empty feedback', () => {
    expect(parseJudgeCritique('0.9')).toEqual({ score: 0.9, feedback: '' });
  });

  it('treats unmarked prose as feedback and scores it 0 with a reason', () => {
    const { score, feedback, reason } = parseJudgeCritique('the output looks great');
    expect(score).toBe(0);
    expect(Number.isNaN(score)).toBe(false);
    expect(feedback).toBe('the output looks great');
    expect(reason).toBeDefined();
  });

  it('uses prose after a SCORE line as feedback when no FEEDBACK marker exists', () => {
    const { score, feedback } = parseJudgeCritique('SCORE: 0.4\nAdd a citation for each claim.');
    expect(score).toBe(0.4);
    expect(feedback).toBe('Add a citation for each claim.');
  });

  it('returns empty feedback for an empty FEEDBACK marker or an empty response', () => {
    expect(parseJudgeCritique('SCORE: 0.9\nFEEDBACK:')).toEqual({ score: 0.9, feedback: '' });
    const { score, feedback, reason } = parseJudgeCritique('');
    expect(score).toBe(0);
    expect(feedback).toBe('');
    expect(reason).toBeDefined();
  });
});

describe('llmJudge() structural isolation guard', () => {
  const originalEnv = process.env.LOUSHO_ALLOW_LLM_JUDGE;

  beforeEach(() => {
    delete process.env.LOUSHO_ALLOW_LLM_JUDGE;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.LOUSHO_ALLOW_LLM_JUDGE;
    } else {
      process.env.LOUSHO_ALLOW_LLM_JUDGE = originalEnv;
    }
  });

  const mockProvider: LLMProvider = {
    generate: async () => ({ text: '0.9' }) as never,
  } as never;

  it('refuses to run outside the judge-eval runner (LOUSHO_ALLOW_LLM_JUDGE unset)', async () => {
    const scorer = llmJudge({ provider: mockProvider, model: 'test-model', rubric: 'be good' });
    await expect(scorer({ text: 'hello' } as never)).rejects.toThrow(
      /llmJudge\(\) was invoked outside the judge-eval runner/
    );
  });

  it('runs normally when LOUSHO_ALLOW_LLM_JUDGE=1 (set by vitest.judge.config.ts)', async () => {
    process.env.LOUSHO_ALLOW_LLM_JUDGE = '1';
    const scorer = llmJudge({ provider: mockProvider, model: 'test-model', rubric: 'be good' });
    await expect(scorer({ text: 'hello' } as never)).resolves.toBe(0.9);
  });

  it("runs on the provider's own model when no model is given", async () => {
    process.env.LOUSHO_ALLOW_LLM_JUDGE = '1';
    const models: Array<string | undefined> = [];
    const provider = { generate: async (options: { model?: string }) => (models.push(options.model), { text: 'Score: 0.6' }) } as never;
    await expect(llmJudge({ provider, rubric: 'be good' })({ text: 'hello' } as never)).resolves.toBe(0.6);
    expect(models).toEqual([undefined]);
  });
});

describe('llmCritique()', () => {
  const originalEnv = process.env.LOUSHO_ALLOW_LLM_JUDGE;

  beforeEach(() => {
    delete process.env.LOUSHO_ALLOW_LLM_JUDGE;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.LOUSHO_ALLOW_LLM_JUDGE;
    } else {
      process.env.LOUSHO_ALLOW_LLM_JUDGE = originalEnv;
    }
  });

  it('carries the same outside-the-judge-runner guard as llmJudge()', async () => {
    const provider: LLMProvider = {
      generate: async () => ({ text: 'SCORE: 0.9\nFEEDBACK: none' }) as never,
    } as never;
    const critic = llmCritique({ provider, model: 'test-model', rubric: 'be good' });
    await expect(critic({ text: 'hello' } as never)).rejects.toThrow(
      /llmCritique\(\) was invoked outside the judge-eval runner/
    );
  });

  it('returns score and feedback from a single provider call', async () => {
    let calls = 0;
    let prompt = '';
    const provider: LLMProvider = {
      generate: async (options: { messages: Array<{ content: string }> }) => {
        calls++;
        prompt = options.messages[0].content;
        return { text: 'SCORE: 0.4\nFEEDBACK: add citations' } as never;
      },
    } as never;
    const critic = llmCritique({
      provider,
      model: 'test-model',
      rubric: 'be good',
      allowOutsideJudgeRunner: true,
    });
    await expect(critic({ text: 'hello' } as never)).resolves.toEqual({
      score: 0.4,
      feedback: 'add citations',
    });
    expect(calls).toBe(1);
    // The critique prompt asks for the two-marker format and embeds the rubric.
    expect(prompt).toContain('SCORE:');
    expect(prompt).toContain('FEEDBACK:');
    expect(prompt).toContain('be good');
  });

  it('handles a malformed judge response like parseJudgeScore does', async () => {
    const provider: LLMProvider = {
      generate: async () => ({ text: 'no idea' }) as never,
    } as never;
    const critic = llmCritique({
      provider,
      model: 'test-model',
      rubric: 'be good',
      allowOutsideJudgeRunner: true,
    });
    const { score, feedback, reason } = await critic({ text: 'hello' } as never);
    expect(score).toBe(0);
    expect(feedback).toBe('no idea');
    expect(reason).toBeDefined();
  });
});
