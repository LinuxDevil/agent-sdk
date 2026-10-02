import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseJudgeScore, llmJudge } from './llmJudge';
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

  it('treats an empty response the same as a malformed one', () => {
    const { score, reason } = parseJudgeScore('');
    expect(score).toBe(0);
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
});
