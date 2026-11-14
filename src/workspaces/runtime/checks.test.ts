import { describe, expect, it } from 'vitest';
import { equals } from '../../evals/checks';
import { readFixtureTree } from '../__fixtures__/readTree';
import { validateWorkspace } from '../contracts/validate';
import { checkNameOf, checkRegistry, resolveCheck } from './checks';

const BUILTIN = 'builtin:output-field-matches?field=ranking&schema=%7B%22minLength%22%3A1%7D';

function withCheck(check: string): Record<string, unknown> {
  const tree = readFixtureTree('coding');
  const path = 'pages/support-triage/harness/harness.json';
  const harness = structuredClone(tree[path]) as { evaluation: { criteria: { check?: string }[] } };
  harness.evaluation.criteria[0].check = check;
  const files = Object.fromEntries(Object.entries(tree).filter(([file]) => !file.startsWith('pages/support-triage/harness/checks/')));
  return { ...files, [path]: harness };
}

const problemsAt = (check: string): string[] => validateWorkspace(withCheck(check)).filter((item) => item.severity === 'error').map((item) => `${item.code} ${item.file}`);

describe('check names (D1)', () => {
  it('a script path names its base name without the extension', () => {
    expect(checkNameOf('harness/checks/script-present.ts')).toBe('script-present');
    expect(checkNameOf('harness/checks/script-present.mjs')).toBe('script-present');
    expect(checkNameOf('script-present.js')).toBe('script-present');
  });

  it('a bare name and a builtin ref are their own names', () => {
    expect(checkNameOf('script-present')).toBe('script-present');
    expect(checkNameOf(BUILTIN)).toBe(BUILTIN);
  });

  it('the host registry resolves all three forms by name', () => {
    const present = equals<unknown>('x');
    const builtin = equals<unknown>('y');
    const registry = checkRegistry({ 'ranking-present': present, [BUILTIN]: builtin });
    expect(resolveCheck(registry, 'pages/support-triage/harness/checks/ranking-present.ts')).toBe(present);
    expect(resolveCheck(registry, 'ranking-present')).toBe(present);
    expect(resolveCheck(registry, BUILTIN)).toBe(builtin);
    expect(resolveCheck(registry, 'missing')).toBeUndefined();
    expect(resolveCheck(registry, 'toString')).toBeUndefined();
  });

  it('a criterion may name a registry check without a .ts file; a script path must exist', () => {
    expect(problemsAt('ranking-present')).toEqual([]);
    expect(problemsAt(BUILTIN)).toEqual([]);
    expect(problemsAt('harness/checks/ranking-present.ts')).toEqual(['PRD032 pages/support-triage/harness/checks/ranking-present.ts']);
  });
});
