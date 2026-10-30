import { describe, it, expect } from 'vitest';
import type { PermissionContext, PermissionRule } from '../../../execution/permissions';
import { permissionsFromSpec, toolMatcherOf } from './permissions';

const ctx: PermissionContext = { toolName: 'shell', toolCallId: 't' };

const whenOf = (rule: PermissionRule): NonNullable<PermissionRule['when']> => {
  if (rule.when === undefined) throw new Error('expected the rule to set when');
  return rule.when;
};

describe('toolMatcherOf', () => {
  it('keeps literals, * and lists of literals as strings', () => {
    expect(toolMatcherOf('shell')).toBe('shell');
    expect(toolMatcherOf('*')).toBe('*');
    expect(toolMatcherOf(['a', 'b'])).toEqual(['a', 'b']);
    expect(toolMatcherOf(['a', '*'])).toBe('*');
  });

  it('compiles a glob to an anchored RegExp', () => {
    const matcher = toolMatcherOf('github_*');
    expect(matcher).toBeInstanceOf(RegExp);
    const regex = matcher as RegExp;
    expect(regex.test('github_create_issue')).toBe(true);
    expect(regex.test('xgithub_a')).toBe(false);
    expect(regex.test('github')).toBe(false);
  });

  it('escapes regex metacharacters in literal parts of a glob list', () => {
    const matcher = toolMatcherOf(['read_?', 'a.b']);
    expect(matcher).toBeInstanceOf(RegExp);
    const regex = matcher as RegExp;
    expect(regex.test('read_x')).toBe(true);
    expect(regex.test('read_xy')).toBe(false);
    expect(regex.test('a.b')).toBe(true);
    expect(regex.test('aXb')).toBe(false);
  });
});

describe('permissionsFromSpec', () => {
  it('compiles a when regex tested against String(arg)', async () => {
    const [rule] = permissionsFromSpec([
      { id: 'p1', tool: 'shell', when: { command: '\\brm\\b' }, action: 'deny', reason: 'No' },
    ]);
    const when = whenOf(rule);
    expect(await when({ command: 'rm -rf /' }, ctx)).toBe(true);
    expect(await when({ command: 'ls' }, ctx)).toBe(false);
  });

  it('compiles when operators with agent-directory semantics (numbers fail closed)', async () => {
    const [rule] = permissionsFromSpec([
      { id: 'p1', tool: 'deploy', action: 'ask', when: { replicas: { gte: 1, lte: 10 } } },
    ]);
    const when = whenOf(rule);
    expect(await when({ replicas: 5 }, ctx)).toBe(true);
    expect(await when({ replicas: '5' }, ctx)).toBe(true);
    expect(await when({ replicas: null }, ctx)).toBe(false);
    expect(await when({ replicas: 11 }, ctx)).toBe(false);
  });

  it('carries ttlMs and reason over and preserves rule order', () => {
    const rules = permissionsFromSpec([
      { id: 'p1', tool: 'shell', action: 'ask', ttlMs: 60000, reason: 'Careful' },
      { id: 'p2', tool: '*', action: 'allow' },
    ]);
    expect(rules.map((rule) => rule.action)).toEqual(['ask', 'allow']);
    expect(rules[0]).toMatchObject({ tool: 'shell', ttlMs: 60000, reason: 'Careful' });
    expect(rules[1].tool).toBe('*');
    expect(rules[1].reason).toBeUndefined();
  });
});
