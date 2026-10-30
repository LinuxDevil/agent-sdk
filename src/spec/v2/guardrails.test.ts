import { describe, it, expect } from 'vitest';
import { ValidationError } from '../../execution/errors';
import { parseAgentSpecV2 } from './parse';

const base = { version: 2, name: 'support', model: 'anthropic/claude-sonnet-5-5', instructions: 'Help.' };

function spec(guardrails: unknown) {
  return { ...base, guardrails };
}

function thrown(data: unknown): ValidationError {
  try {
    parseAgentSpecV2(data);
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error('expected parseAgentSpecV2 to throw');
}

describe('spec v2 guardrails', () => {
  it('accepts entries with ids, sides, runInParallel and options', () => {
    const guardrails = [
      { id: 'g1', name: 'pii', options: { types: ['email'] } },
      { id: 'g2', name: 'regex', on: ['input', 'tools'], options: { pattern: 'secret' } },
      { id: 'g3', name: 'prompt-injection', on: 'input', runInParallel: true },
    ];
    expect(parseAgentSpecV2(spec(guardrails)).guardrails).toEqual(guardrails);
  });

  it('suggests the built-in a bad name is a typo of', () => {
    const error = thrown(spec([{ id: 'g1', name: 'pi' }]));
    expect(error.code).toBe('LOUSHO_SPEC_INVALID');
    expect(error.message).toContain("did you mean 'pii'");
  });

  it("flags 'on' inside options: it belongs on the guardrail itself", () => {
    const error = thrown(spec([{ id: 'g1', name: 'pii', options: { on: 'input' } }]));
    expect(error.errors).toHaveProperty('guardrails.0.options.on');
    expect(error.message).toContain("move 'on' out of options, onto the guardrail itself");
  });

  it('forwards the built-in options issues under guardrails.<i>.options', () => {
    const missing = thrown(spec([{ id: 'g1', name: 'regex', options: {} }]));
    expect(missing.errors).toHaveProperty('guardrails.0.options.pattern');
    const bad = thrown(spec([{ id: 'g1', name: 'regex', options: { pattern: '(' } }]));
    expect(bad.message).toContain('pattern is not a valid regular expression');
  });

  it("rejects onTripped 'warn' as not supported yet", () => {
    const error = thrown(spec([{ id: 'g1', name: 'pii', onTripped: 'warn' }]));
    expect(error.code).toBe('LOUSHO_SPEC_UNSUPPORTED');
    expect(error.message).toContain("onTripped 'warn'");
  });

  it("rejects onTripped 'rewrite' on a guardrail that cannot rewrite", () => {
    const error = thrown(spec([{ id: 'g1', name: 'max-length', onTripped: 'rewrite' }]));
    expect(error.errors).toHaveProperty('guardrails.0.onTripped');
    expect(error.message).toContain("'max-length' cannot rewrite; use 'block'");
  });

  it('rejects onTripped and options.action both set to different values', () => {
    const error = thrown(spec([{ id: 'g1', name: 'pii', onTripped: 'block', options: { action: 'rewrite' } }]));
    expect(error.errors).toHaveProperty('guardrails.0.options.action');
    expect(error.message).toContain('set either onTripped or options.action, not both');
  });

  it('rejects runInParallel on a guardrail that does not check the input', () => {
    const error = thrown(
      spec([{ id: 'g1', name: 'moderation', options: { model: 'openai/gpt-4o-mini' }, on: 'output', runInParallel: true }])
    );
    expect(error.errors).toHaveProperty('guardrails.0.runInParallel');
    expect(error.message).toContain('only input guardrails run in parallel');
  });

  it('rejects runInParallel on a guardrail that rewrites', () => {
    const error = thrown(spec([{ id: 'g1', name: 'pii', onTripped: 'rewrite', runInParallel: true }]));
    expect(error.errors).toHaveProperty('guardrails.0.runInParallel');
    expect(error.message).toContain('a parallel guardrail cannot rewrite');
  });

  it('rejects duplicate ids', () => {
    const error = thrown(
      spec([
        { id: 'g1', name: 'pii' },
        { id: 'g1', name: 'regex', options: { pattern: 'x' } },
      ])
    );
    expect(error.message).toContain("duplicate id 'g1'");
    expect(error.errors).toHaveProperty('guardrails.1.id');
  });
});
