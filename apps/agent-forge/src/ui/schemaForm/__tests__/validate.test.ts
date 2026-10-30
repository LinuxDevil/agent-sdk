import { describe, expect, it } from 'vitest';

import { issuesByPath, validateSchemaValue } from '../validate';

import { SCHEMA } from './fixture';

describe('validateSchemaValue', () => {
  it('reports Required. for each missing required property', () => {
    expect(validateSchemaValue(SCHEMA, {})).toEqual([
      { path: 'name', message: 'Required.' },
      { path: 'model', message: 'Required.' },
    ]);
  });

  it('treats an empty string as absent, required or not', () => {
    expect(validateSchemaValue(SCHEMA, { name: '', model: 'm' })).toEqual([
      { path: 'name', message: 'Required.' },
    ]);
    expect(validateSchemaValue(SCHEMA, { name: 'x', model: 'm', reasoning: undefined })).toEqual([]);
  });

  it('checks numeric bounds and integer-ness', () => {
    expect(validateSchemaValue(SCHEMA, { name: 'x', model: 'm', maxSteps: 0 })).toEqual([
      { path: 'maxSteps', message: 'Must be at least 1.' },
    ]);
    expect(validateSchemaValue(SCHEMA, { name: 'x', model: 'm', maxSteps: 1.5 })).toEqual([
      { path: 'maxSteps', message: 'Must be a whole number.' },
    ]);
  });

  it('rejects values outside an enum', () => {
    expect(validateSchemaValue(SCHEMA, { name: 'x', model: 'm', reasoning: 'max' })).toEqual([
      { path: 'reasoning', message: 'Pick one of the listed values.' },
    ]);
  });

  it('validates through $ref into nested object paths', () => {
    expect(validateSchemaValue(SCHEMA, { name: 'x', model: 'm', modelSettings: { temperature: 3 } })).toEqual([
      { path: 'modelSettings.temperature', message: 'Must be at most 2.' },
    ]);
  });

  it('reports a type mismatch for a non-array value on an array schema', () => {
    expect(validateSchemaValue(SCHEMA, { name: 'x', model: 'm', fallbackModels: 'x' })).toEqual([
      { path: 'fallbackModels', message: 'Must be a list.' },
    ]);
  });

  it('checks string length and pattern keywords', () => {
    const issues = validateSchemaValue(SCHEMA, {
      name: 'x'.repeat(65),
      model: 'm',
      modelSettings: {},
    });
    expect(issues).toEqual([{ path: 'name', message: 'Must be at most 64 characters.' }]);
    expect(
      validateSchemaValue(
        { type: 'object', properties: { zip: { type: 'string', pattern: '^[0-9]+$' } } },
        { zip: 'abc' },
      ),
    ).toEqual([{ path: 'zip', message: 'Doesn’t match the expected format.' }]);
  });

  it('checks array item counts and validates each item', () => {
    const issues = validateSchemaValue(SCHEMA, {
      name: 'x',
      model: 'm',
      modelSettings: { temperature: -1 },
    });
    expect(issues).toEqual([{ path: 'modelSettings.temperature', message: 'Must be at least 0.' }]);
    expect(
      validateSchemaValue(
        { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' }, minItems: 2 } } },
        { tags: [1] },
      ),
    ).toEqual([
      { path: 'tags', message: 'Add at least 2.' },
      { path: 'tags.0', message: 'Must be text.' },
    ]);
  });
});

describe('issuesByPath', () => {
  it('keeps the first message per path', () => {
    expect(
      issuesByPath([
        { path: 'a', message: 'first' },
        { path: 'a', message: 'second' },
        { path: 'b', message: 'other' },
      ]),
    ).toEqual({ a: 'first', b: 'other' });
  });
});
