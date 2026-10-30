import { describe, it, expect } from 'vitest';
import { ValidationError } from '../../execution/errors';
import { parseAgentSpecV2 } from './parse';

const base = { version: 2, name: 'support', model: 'anthropic/claude-sonnet-5-5', instructions: 'Help.' };

function thrown(data: unknown): ValidationError {
  try {
    parseAgentSpecV2(data);
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error('expected parseAgentSpecV2 to throw');
}

describe('parseAgentSpecV2', () => {
  it('returns a minimal valid spec', () => {
    expect(parseAgentSpecV2(base)).toEqual(base);
  });

  it('accepts instructions as a file reference', () => {
    const spec = { ...base, instructions: { file: 'prompts/main.md' } };
    expect(parseAgentSpecV2(spec)).toEqual(spec);
  });

  it('rejects an instructions.file that escapes the spec folder', () => {
    const error = thrown({ ...base, instructions: { file: '../x.md' } });
    expect(error.code).toBe('LOUSHO_SPEC_INVALID');
    // zod 3 surfaces the union member's issue ('instructions.file'); zod 4 reports the union itself ('instructions').
    expect(Object.keys(error.errors ?? {}).some((key) => key === 'instructions' || key.startsWith('instructions.'))).toBe(true);
  });

  it('rejects a missing version, naming it', () => {
    const { version: _version, ...noVersion } = base;
    const error = thrown(noVersion);
    expect(error.code).toBe('LOUSHO_SPEC_INVALID');
    expect(error.message).toContain("'version'");
  });

  it('rejects version: 1, telling how to convert', () => {
    const error = thrown({ ...base, version: 1 });
    expect(error.code).toBe('LOUSHO_SPEC_INVALID');
    expect(error.message).toContain('must be 2');
  });

  it('suggests the field an unknown key is a typo of', () => {
    const error = thrown({ ...base, instructons: 'x' });
    expect(error.code).toBe('LOUSHO_SPEC_INVALID');
    expect(error.message).toContain("unknown field 'instructons' (did you mean 'instructions'?)");
  });

  it('reports an unknown key with no plausible match plainly', () => {
    const error = thrown({ ...base, zzzz: 1 });
    expect(error.message).toContain("unknown field 'zzzz'");
    expect(error.message).not.toContain('did you mean');
  });

  it('throws LOUSHO_SPEC_UNSUPPORTED when only placeholder sections are set', () => {
    const error = thrown({ ...base, tools: [] });
    expect(error.code).toBe('LOUSHO_SPEC_UNSUPPORTED');
    expect(error.message).toContain('uses fields this SDK cannot run yet');
    expect(error.message).toContain("'tools'");
  });

  it('throws LOUSHO_SPEC_INVALID when unsupported and invalid problems mix', () => {
    const error = thrown({ ...base, tools: [], model: 'gpt-4o' });
    expect(error.code).toBe('LOUSHO_SPEC_INVALID');
    expect(error.errors).toHaveProperty('tools');
    expect(error.errors).toHaveProperty('model');
  });

  it("rejects a model that is not 'provider/model'", () => {
    expect(thrown({ ...base, model: 'gpt-4o' }).message).toContain("must be 'provider/model'");
  });

  it('validates the agent name', () => {
    expect(parseAgentSpecV2({ ...base, name: 'Support bot 2' }).name).toBe('Support bot 2');
    for (const name of ['', 'a/b', '-x', 'x'.repeat(65)]) {
      expect(thrown({ ...base, name }).code).toBe('LOUSHO_SPEC_INVALID');
    }
  });

  it("accepts a promptRef 'name@label' and rejects a bare name", () => {
    expect(parseAgentSpecV2({ ...base, promptRef: 'support@prod' }).promptRef).toBe('support@prod');
    expect(thrown({ ...base, promptRef: 'support' }).code).toBe('LOUSHO_SPEC_INVALID');
  });

  it('validates instructionsByFamily keys as lowercase model families', () => {
    expect(parseAgentSpecV2({ ...base, instructionsByFamily: { openai: 'x' } }).instructionsByFamily).toEqual({ openai: 'x' });
    expect(thrown({ ...base, instructionsByFamily: { 'Open AI': 'x' } }).code).toBe('LOUSHO_SPEC_INVALID');
  });

  it('validates each fallbackModels entry at its index', () => {
    expect(parseAgentSpecV2({ ...base, fallbackModels: ['openai/gpt-4o-mini'] }).fallbackModels).toEqual(['openai/gpt-4o-mini']);
    const error = thrown({ ...base, fallbackModels: ['gpt-4o'] });
    expect(error.code).toBe('LOUSHO_SPEC_INVALID');
    expect(error.errors).toHaveProperty('fallbackModels.0');
  });

  it('rejects an empty description', () => {
    expect(thrown({ ...base, description: '' }).code).toBe('LOUSHO_SPEC_INVALID');
  });

  it('rejects a non-object spec', () => {
    expect(thrown('nope').code).toBe('LOUSHO_SPEC_INVALID');
  });
});
