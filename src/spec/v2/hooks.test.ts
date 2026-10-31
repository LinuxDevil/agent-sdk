import { describe, it, expect } from 'vitest';
import { ValidationError } from '../../execution/errors';
import { MAX_INLINE_HOOK_CODE } from './hooks';
import { parseAgentSpecV2 } from './parse';
import { agentSpecV2Schema } from './schema';

const base = { version: 2, name: 'support', model: 'anthropic/claude-sonnet-5-5', instructions: 'Help.' };

function spec(hooks: unknown) {
  return { ...base, hooks };
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

describe('spec v2 hooks', () => {
  it('accepts file and inline entries', () => {
    const hooks = [
      { id: 'audit', file: 'hooks/audit.ts' },
      { id: 'redact', inline: { name: 'Redact PII', point: 'postToolCall', code: 'return ctx;' } },
    ];
    const result = agentSpecV2Schema.safeParse(spec(hooks));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.hooks).toEqual(hooks);
  });

  it('rejects a hook point that is not an AgentHook method', () => {
    const error = thrown(spec([{ id: 'x', inline: { name: 'n', point: 'onRunStart', code: 'return ctx;' } }]));
    expect(error.errors).toHaveProperty('hooks.0.inline.point');
    expect(error.message).toContain("must be 'preToolCall', 'postToolCall', 'preGenerate' or 'postGenerate'");
  });

  it('rejects inline code over the size limit', () => {
    const error = thrown(spec([{ id: 'x', inline: { name: 'n', point: 'preToolCall', code: 'x'.repeat(MAX_INLINE_HOOK_CODE + 1) } }]));
    expect(error.errors).toHaveProperty('hooks.0.inline.code');
    expect(error.message).toContain(`must be at most ${MAX_INLINE_HOOK_CODE} characters`);
  });

  it('rejects file refs that escape the agent folder or are not a code file', () => {
    for (const file of ['../x.ts', 'hooks/x.py']) {
      const error = thrown(spec([{ id: 'x', file }]));
      expect(error.errors).toHaveProperty('hooks.0.file');
    }
  });

  it('requires exactly one of file and inline', () => {
    for (const hooks of [
      [{ id: 'x', file: 'a.ts', inline: { name: 'n', point: 'preToolCall', code: 'c' } }],
      [{ id: 'x' }],
      ['a.ts'],
    ]) {
      const error = thrown(spec(hooks));
      expect(error.errors).toHaveProperty('hooks.0');
      expect(error.message).toContain('exactly one of file, inline');
    }
  });

  it('rejects duplicate ids', () => {
    const error = thrown(
      spec([
        { id: 'a', file: 'hooks/one.ts' },
        { id: 'a', inline: { name: 'n', point: 'preGenerate', code: 'c' } },
      ])
    );
    expect(error.errors).toHaveProperty('hooks.1.id');
    expect(error.message).toContain("duplicate id 'a'");
  });
});
