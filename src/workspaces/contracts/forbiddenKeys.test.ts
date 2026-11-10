import { describe, it, expect } from 'vitest';
import { scanForbiddenKeys, formatKeyPath, harnessKeyErrors } from './forbiddenKeys';

describe('scanForbiddenKeys', () => {
  it('finds a custom key list at any depth, inside arrays, with the listed spelling', () => {
    const doc = { agents: [{ as: 'writer', Secrets: {} }, { as: 'editor', nested: { ' permissions': [] } }] };
    expect(scanForbiddenKeys(doc, ['permissions', 'secrets']).hits).toEqual([
      { path: ['agents', 0, 'Secrets'], key: 'secrets' },
      { path: ['agents', 1, 'nested', ' permissions'], key: 'permissions' },
    ]);
  });

  it('checks every key when no JSON Schema path is given', () => {
    expect(scanForbiddenKeys({ inputs: { schema: { properties: { model: {} } } } }, ['model']).hits).toEqual([{ path: ['inputs', 'schema', 'properties', 'model'], key: 'model' }]);
  });

  it('ignores scalars, null and an empty key list', () => {
    const empty = { hits: [], unscannable: [] };
    expect(scanForbiddenKeys(null, ['tools'])).toEqual(empty);
    expect(scanForbiddenKeys('tools', ['tools'])).toEqual(empty);
    expect(scanForbiddenKeys({ tools: [] }, [])).toEqual(empty);
    expect(scanForbiddenKeys(Object.create(null) as object, ['tools'])).toEqual(empty);
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
