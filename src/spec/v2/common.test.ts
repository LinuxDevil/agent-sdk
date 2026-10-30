import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { forwardIssues, isSafeRelativePath, refineUniqueIds, specIdSchema } from './common';

describe('isSafeRelativePath', () => {
  it.each([
    ['a.md', true],
    ['dir/a.md', true],
    ['./a.md', true],
    ['a/./b', true],
    ['', false],
    ['.', false],
    ['a/..', false],
    ['../a.md', false],
    ['a/../../b', false],
    ['/abs', false],
    ['C:/x', false],
    ['a\\b', false],
  ])('%j -> %s', (rel, expected) => {
    expect(isSafeRelativePath(rel)).toBe(expected);
  });
});

describe('refineUniqueIds', () => {
  const list = z.array(z.object({ id: z.string() })).superRefine(refineUniqueIds);

  it('flags a repeated id at [index, "id"]', () => {
    const result = list.safeParse([{ id: 'a' }, { id: 'a' }]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0].path).toEqual([1, 'id']);
      expect(result.error.issues[0].message).toBe("duplicate id 'a'");
    }
  });

  it('passes distinct ids', () => {
    expect(list.safeParse([{ id: 'a' }, { id: 'b' }]).success).toBe(true);
  });
});

describe('specIdSchema', () => {
  it.each(['g1', 'block-pii', 'a.b_c'])('accepts %j', (id) => {
    expect(specIdSchema.safeParse(id).success).toBe(true);
  });

  it.each(['_x', '', 'x'.repeat(65)])('rejects %j', (id) => {
    expect(specIdSchema.safeParse(id).success).toBe(false);
  });
});

describe('forwardIssues', () => {
  const forwarding = z
    .any()
    .superRefine((value, ctx) => forwardIssues(z.object({ a: z.number() }).safeParse(value), ctx, ['x']));

  it('copies the inner issues under the prefix', () => {
    const result = forwarding.safeParse({ a: 'no' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0].path).toEqual(['x', 'a']);
    }
  });

  it('adds nothing when the inner parse succeeds', () => {
    expect(forwarding.safeParse({ a: 1 }).success).toBe(true);
  });
});
