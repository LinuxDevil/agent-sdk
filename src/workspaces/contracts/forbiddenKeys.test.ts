import { describe, it, expect } from 'vitest';
import { findForbiddenKeys, formatKeyPath, harnessKeyErrors } from './forbiddenKeys';

describe('findForbiddenKeys', () => {
  it('finds a custom key list at any depth, inside arrays, with the listed spelling', () => {
    const doc = { agents: [{ as: 'writer', Secrets: {} }, { as: 'editor', nested: { ' permissions': [] } }] };
    expect(findForbiddenKeys(doc, ['permissions', 'secrets'])).toEqual([
      { path: ['agents', 0, 'Secrets'], key: 'secrets' },
      { path: ['agents', 1, 'nested', ' permissions'], key: 'permissions' },
    ]);
  });

  it('checks every key when no JSON Schema path is given', () => {
    expect(findForbiddenKeys({ inputs: { schema: { properties: { model: {} } } } }, ['model'])).toEqual([{ path: ['inputs', 'schema', 'properties', 'model'], key: 'model' }]);
  });

  it('ignores scalars, null and an empty key list', () => {
    expect(findForbiddenKeys(null, ['tools'])).toEqual([]);
    expect(findForbiddenKeys('tools', ['tools'])).toEqual([]);
    expect(findForbiddenKeys({ tools: [] }, [])).toEqual([]);
  });
});

describe('formatKeyPath', () => {
  it('writes plain keys with dots, indexes and other keys in brackets', () => {
    expect(formatKeyPath('harness', ['constraints', 0, 'a-b', 'x​y'])).toBe('harness.constraints[0]["a-b"]["x\\u200by"]');
    expect(formatKeyPath('harness', [])).toBe('harness');
  });
});

describe('harnessKeyErrors', () => {
  it('uses the given root in the message', () => {
    expect(harnessKeyErrors({ hooks: {} }, 'main-harness')).toEqual([{ path: ['hooks'], message: 'main-harness.hooks: harnesses describe the task; the runtime enforces hooks (R13)' }]);
  });
});
