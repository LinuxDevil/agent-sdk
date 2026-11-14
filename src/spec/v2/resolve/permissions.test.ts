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
    const { rules } = permissionsFromSpec([
      { id: 'p1', tool: 'shell', when: { command: '\\brm\\b' }, action: 'deny', reason: 'No' },
    ]);
    const when = whenOf(rules[0]);
    expect(await when({ command: 'rm -rf /' }, ctx)).toBe(true);
    expect(await when({ command: 'ls' }, ctx)).toBe(false);
  });

  it('compiles when operators with agent-directory semantics (numbers fail closed)', async () => {
    const { rules } = permissionsFromSpec([
      { id: 'p1', tool: 'deploy', action: 'ask', when: { replicas: { gte: 1, lte: 10 } } },
    ]);
    const when = whenOf(rules[0]);
    expect(await when({ replicas: 5 }, ctx)).toBe(true);
    expect(await when({ replicas: '5' }, ctx)).toBe(true);
    expect(await when({ replicas: null }, ctx)).toBe(false);
    expect(await when({ replicas: 11 }, ctx)).toBe(false);
  });

  it('carries ttlMs and reason over and preserves rule order', () => {
    const { rules } = permissionsFromSpec([
      { id: 'p1', tool: 'shell', action: 'ask', ttlMs: 60000, reason: 'Careful' },
      { id: 'p2', tool: '*', action: 'allow' },
    ]);
    expect(rules.map((rule) => rule.action)).toEqual(['ask', 'allow']);
    expect(rules[0]).toMatchObject({ tool: 'shell', ttlMs: 60000, reason: 'Careful' });
    expect(rules[1].tool).toBe('*');
    expect(rules[1].reason).toBeUndefined();
  });
});

describe('permissionsFromSpec auto rules', () => {
  it("compiles action 'auto' to 'ask', keeping tool matcher, when, reason and ttlMs", () => {
    const { rules } = permissionsFromSpec([
      { id: 'p1', tool: 'github_*', action: 'auto', when: { repo: 'app' }, reason: 'Routine', ttlMs: 30000 },
    ]);
    expect(rules).toHaveLength(1);
    expect(rules[0].action).toBe('ask');
    expect(rules[0].tool).toBeInstanceOf(RegExp);
    expect(rules[0].reason).toBe('Routine');
    expect(rules[0].ttlMs).toBe(30000);
    expect(rules[0].when).toBeDefined();
  });

  it('isAuto is true only when the first matching rule is auto', () => {
    const { isAuto } = permissionsFromSpec([
      { id: 'p1', tool: 'github_*', action: 'auto' },
      { id: 'p2', tool: 'github_create_issue', action: 'ask' },
    ]);
    expect(isAuto('github_create_issue', {})).toBe(true);
    expect(isAuto('github_close_issue', {})).toBe(true);
    expect(isAuto('shell', {})).toBe(false);
  });

  it('isAuto respects when narrowing on the auto rule itself', () => {
    const { isAuto } = permissionsFromSpec([
      { id: 'p1', tool: 'deploy', action: 'auto', when: { env: 'prod' } },
      { id: 'p2', tool: 'deploy', action: 'ask' },
    ]);
    expect(isAuto('deploy', { env: 'prod' })).toBe(true);
    expect(isAuto('deploy', { env: 'staging' })).toBe(false);
  });

  it('an allow rule before an auto rule shadows it - the model is never consulted', () => {
    const { rules, isAuto } = permissionsFromSpec([
      { id: 'p1', tool: 'github_*', action: 'allow' },
      { id: 'p2', tool: 'github_create_issue', action: 'auto' },
    ]);
    expect(rules.map((rule) => rule.action)).toEqual(['allow', 'ask']);
    expect(isAuto('github_create_issue', {})).toBe(false);
  });

  it('a deny rule before an auto rule shadows it too', () => {
    const { isAuto } = permissionsFromSpec([
      { id: 'p1', tool: 'github_delete_*', action: 'deny' },
      { id: 'p2', tool: 'github_*', action: 'auto' },
    ]);
    expect(isAuto('github_delete_repo', {})).toBe(false);
    expect(isAuto('github_create_issue', {})).toBe(true);
  });

  it('isAuto is false when no rule matches', () => {
    const { isAuto } = permissionsFromSpec([{ id: 'p1', tool: 'github_*', action: 'auto' }]);
    expect(isAuto('shell', {})).toBe(false);
  });
});
