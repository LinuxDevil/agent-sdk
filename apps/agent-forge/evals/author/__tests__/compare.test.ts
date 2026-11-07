import { describe, it, expect } from 'vitest';
import { comparePassRate, type AuthorEvalBaseline } from '../compare';
import { isVerbatimEvidence } from '../judge';

/**
 * The baseline compare thresholds (5-point tolerance) and the judge's
 * verbatim-evidence rule.
 */

const baseline = (passRate: number): AuthorEvalBaseline => ({ passRate, date: '2026-10-30', model: 'anthropic/claude-sonnet-5-5' });

describe('comparePassRate', () => {
  it('fails when the run drops more than 5 points (0.74 vs 0.80)', () => {
    const outcome = comparePassRate(0.74, baseline(0.8));
    expect(outcome.ok).toBe(false);
    expect(outcome.regression).toBeCloseTo(0.06);
  });

  it('passes inside the tolerance (0.76 vs 0.80)', () => {
    expect(comparePassRate(0.76, baseline(0.8)).ok).toBe(true);
  });

  it('passes at exactly the 5-point boundary (0.75 vs 0.80)', () => {
    expect(comparePassRate(0.75, baseline(0.8)).ok).toBe(true);
  });

  it('passes on par or above the baseline', () => {
    expect(comparePassRate(0.8, baseline(0.8)).ok).toBe(true);
    expect(comparePassRate(0.95, baseline(0.8)).ok).toBe(true);
  });

  it('passes with no baseline to compare against', () => {
    const outcome = comparePassRate(0.5, undefined);
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain('no baseline');
  });
});

describe('isVerbatimEvidence', () => {
  const sources = ['Use the secure card to share your GitHub token.', 'proposeAgent({"draft":{"name":"Support triage"}})'];

  it('accepts a verbatim >= 8-char quote from an assistant text', () => {
    expect(isVerbatimEvidence('secure card to share your GitHub token', sources)).toBe(true);
  });

  it('accepts a quote from a tool input', () => {
    expect(isVerbatimEvidence('Support triage', sources)).toBe(true);
  });

  it('rejects a quote that is not in the transcript', () => {
    expect(isVerbatimEvidence('the agent was saved successfully', sources)).toBe(false);
  });

  it('rejects quotes shorter than 8 characters and non-strings', () => {
    expect(isVerbatimEvidence('card to', sources)).toBe(false);
    expect(isVerbatimEvidence(42, sources)).toBe(false);
    expect(isVerbatimEvidence(undefined, sources)).toBe(false);
  });
});
