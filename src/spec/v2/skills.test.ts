import { describe, it, expect } from 'vitest';
import { ValidationError } from '../../execution/errors';
import { parseAgentSpecV2 } from './parse';
import { skillRefListSchema, skillRefSchema } from './skills';

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

describe('skillRefSchema', () => {
  it('parses each of the three ref forms', () => {
    expect(skillRefSchema.safeParse({ dir: 'skills' }).success).toBe(true);
    expect(skillRefSchema.safeParse({ registry: 'changelog' }).success).toBe(true);
    const inline = { inline: { name: 'tone', description: 'House tone', content: 'Write plainly.' } };
    expect(skillRefSchema.safeParse(inline)).toMatchObject({ success: true, data: inline });
  });

  it('rejects an entry carrying two kind keys', () => {
    expect(skillRefSchema.safeParse({ dir: 'x', registry: 'y' }).success).toBe(false);
  });

  it('names the three ref forms when the entry is not object-shaped', () => {
    const result = skillRefSchema.safeParse('changelog');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        'each skills entry must be { dir }, { registry } or { inline: { name, description, content } }'
      );
    }
  });

  it('rejects a registry name that is not a skill name', () => {
    expect(skillRefSchema.safeParse({ registry: 'Bad Name' }).success).toBe(false);
  });

  it('rejects an inline ref without content', () => {
    expect(skillRefSchema.safeParse({ inline: { name: 'tone', description: 'House tone' } }).success).toBe(false);
  });

  it('rejects an inline name that is not a skill name', () => {
    const inline = { inline: { name: 'Bad Name', description: 'House tone', content: 'Write plainly.' } };
    expect(skillRefSchema.safeParse(inline).success).toBe(false);
  });
});

describe('skillRefListSchema', () => {
  it('rejects duplicate inline names at skills.<i>.inline.name', () => {
    const result = skillRefListSchema.safeParse([
      { inline: { name: 'tone', description: 'a', content: 'c' } },
      { dir: 'skills' },
      { inline: { name: 'tone', description: 'b', content: 'c' } },
    ]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({
        message: "duplicate skill name 'tone'",
        path: [2, 'inline', 'name'],
      });
    }
  });

  it('accepts an inline name repeated by a folder skill (names are only data)', () => {
    const result = skillRefListSchema.safeParse([
      { inline: { name: 'tone', description: 'a', content: 'c' } },
      { dir: 'tone' },
    ]);
    expect(result.success).toBe(true);
  });
});

describe('spec.skills in parseAgentSpecV2', () => {
  it('accepts a spec carrying skills', () => {
    const spec = {
      ...base,
      skills: [{ dir: 'skills' }, { registry: 'changelog' }, { inline: { name: 'tone', description: 't', content: 'c' } }],
    };
    expect(parseAgentSpecV2(spec)).toEqual(spec);
  });

  it('reports a malformed entry at its skills path', () => {
    const error = thrown({ ...base, skills: [{ dir: 'x', registry: 'y' }] });
    expect(error.code).toBe('LOUSHO_SPEC_INVALID');
    expect(error.errors).toHaveProperty('skills.0');
  });
});
