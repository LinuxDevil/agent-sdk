import { describe, it, expect } from 'vitest';
import { INHERITANCE_RULES, SHARED_FOLDERS, SHARED_PATH_PATTERNS, SHARED_POLICY_FILE, orderInstructionFiles, sharedReferenceSchema } from './shared';

describe('shared layout', () => {
  it('instructions order is by file name', () => {
    const paths = [
      'shared/instructions/10-tone.md',
      'shared/instructions/02-audience.md',
      'shared/instructions/00-brand-voice.md',
      'shared/instructions/notes.txt',
      'shared/instructions/nested/01-x.md',
      'shared/knowledge/a.md',
      'shared/instructions/B.md',
    ];
    expect(orderInstructionFiles(paths)).toEqual([
      'shared/instructions/00-brand-voice.md',
      'shared/instructions/02-audience.md',
      'shared/instructions/10-tone.md',
      'shared/instructions/B.md',
    ]);
  });

  it('orders the same however the input is ordered', () => {
    const a = ['shared/instructions/b.md', 'shared/instructions/a.md'];
    expect(orderInstructionFiles(a)).toEqual(orderInstructionFiles([...a].reverse()));
    expect(orderInstructionFiles([])).toEqual([]);
  });

  it('the inheritance table covers every shared folder', () => {
    const covered = INHERITANCE_RULES.flatMap((row) => row.folders);
    expect([...covered].sort()).toEqual([...SHARED_FOLDERS].sort());
    expect(new Set(covered).size).toBe(covered.length);
  });

  it('has a path pattern for every folder', () => {
    expect(Object.keys(SHARED_PATH_PATTERNS).sort()).toEqual([...SHARED_FOLDERS].sort());
    expect(SHARED_PATH_PATTERNS.skills.test('shared/skills/brand-check/SKILL.md')).toBe(true);
    expect(SHARED_PATH_PATTERNS.skills.test('shared/skills/Brand/SKILL.md')).toBe(false);
    expect(SHARED_PATH_PATTERNS.memory.test('shared/memory/facts.ts')).toBe(true);
    expect(SHARED_PATH_PATTERNS.memory.test('shared/memory/a/facts.ts')).toBe(false);
    expect(SHARED_PATH_PATTERNS.policies.test(SHARED_POLICY_FILE)).toBe(true);
    expect(SHARED_PATH_PATTERNS.policies.test('shared/policies/other.json')).toBe(false);
    expect(SHARED_PATH_PATTERNS.knowledge.test('shared/knowledge/a/b.md')).toBe(true);
  });

  it('names the main agent rule', () => {
    expect(INHERITANCE_RULES.map((row) => row.item)).toContain('main agent');
  });
});

describe('sharedReferenceSchema', () => {
  it.each(['shared:knowledge/faq.md', 'shared:brand/palette.json', 'shared:resources/logos/main.svg'])('accepts %s', (ref) => {
    expect(sharedReferenceSchema.safeParse(ref).success).toBe(true);
  });

  it.each([
    'knowledge/faq.md',
    'shared:',
    'shared:knowledge',
    'shared:instructions/a.md',
    'shared:knowledge/../policies/policy.json',
    'shared:/knowledge/a.md',
    'shared:knowledge\\a.md',
  ])('rejects %s', (ref) => {
    expect(sharedReferenceSchema.safeParse(ref).success).toBe(false);
  });
});
