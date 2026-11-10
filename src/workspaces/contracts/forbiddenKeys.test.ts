import { describe, it, expect } from 'vitest';
import { checkForbiddenKeys, forbiddenKeyErrors, harnessKeyErrors, type ForbiddenKeyRule } from './forbiddenKeys';

const rules: ForbiddenKeyRule[] = [{ keys: ['permissions', 'secrets'], message: (at, key) => `${at}: ${key} lives in the agent (R13)` }];

describe('forbiddenKeyErrors', () => {
  it('finds a custom key list at any depth, inside arrays, with the listed spelling', () => {
    const doc = { agents: [{ as: 'writer', Secrets: {} }, { as: 'editor', nested: { ' permissions': [] } }] };
    expect(forbiddenKeyErrors(doc, rules, 'agents')).toEqual([
      { path: ['agents', 0, 'Secrets'], message: 'agents.agents[0].Secrets: secrets lives in the agent (R13)' },
      { path: ['agents', 1, 'nested', ' permissions'], message: 'agents.agents[1].nested[" permissions"]: permissions lives in the agent (R13)' },
    ]);
  });

  it('checks every key when no JSON Schema path is given', () => {
    expect(forbiddenKeyErrors({ inputs: { schema: { properties: { secrets: {} } } } }, rules, 'x').map((e) => e.path)).toEqual([['inputs', 'schema', 'properties', 'secrets']]);
  });

  it('folds unscannable values into the errors', () => {
    expect(forbiddenKeyErrors({ a: new Map() }, rules, 'x')).toEqual([{ path: ['a'], message: 'x.a: must be plain JSON data: no class instances, Maps, inherited properties or getters' }]);
  });

  it('ignores scalars, null and an empty rule list', () => {
    expect(forbiddenKeyErrors(null, rules, 'x')).toEqual([]);
    expect(forbiddenKeyErrors('secrets', rules, 'x')).toEqual([]);
    expect(forbiddenKeyErrors({ secrets: [] }, [], 'x')).toEqual([]);
    expect(forbiddenKeyErrors(Object.create(null) as object, rules, 'x')).toEqual([]);
  });

  it('escapes invisible characters in bracketed path segments', () => {
    expect(forbiddenKeyErrors({ 'se​crets': 1 }, rules, 'x')[0].message).toBe('x["se\\u200bcrets"]: secrets lives in the agent (R13)');
  });
});

describe('checkForbiddenKeys', () => {
  it('returns a plain copy of what it read, including non-enumerable properties and a __proto__ key', () => {
    const source = JSON.parse('{"a":[1,{"b":"c"}],"__proto__":{"d":1}}') as object;
    Object.defineProperty(source, 'hidden', { value: 2, enumerable: false });
    const { errors, data } = checkForbiddenKeys(source, rules, 'x');
    expect(errors).toEqual([]);
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
    expect(Object.keys(data as object)).toEqual(['a', '__proto__', 'hidden']);
    expect((data as { a: unknown }).a).toEqual([1, { b: 'c' }]);
    expect(data).not.toBe(source);
  });
});

describe('harnessKeyErrors', () => {
  it('uses the given root in the message', () => {
    expect(harnessKeyErrors({ hooks: {} }, 'main-harness')).toEqual([{ path: ['hooks'], message: 'main-harness.hooks: harnesses describe the task; the runtime enforces hooks (R13)' }]);
  });
});
