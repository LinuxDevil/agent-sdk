import { describe, expect, it } from 'vitest';

import { fieldKind, humanize } from '../fieldKind';
import { resolveRef } from '../schemaPath';

import { SCHEMA, SPEC } from './fixture';

describe('fieldKind', () => {
  it('picks the right kind for every fixture property', () => {
    const props = SCHEMA.properties!;
    expect(fieldKind(props.name!)).toBe('string');
    expect(fieldKind(props.model!)).toBe('string');
    expect(fieldKind(props.reasoning!)).toBe('enum');
    expect(fieldKind(props.maxSteps!)).toBe('integer');
    expect(fieldKind(props.askQuestion!)).toBe('boolean');
    expect(fieldKind(props.fallbackModels!)).toBe('primitiveArray');
    expect(fieldKind(resolveRef(SCHEMA, props.modelSettings!))).toBe('object');
    expect(fieldKind(props.output!)).toBe('json');
  });

  it('strips null from a type array and falls back to json for real unions', () => {
    expect(fieldKind({ type: ['string', 'null'] })).toBe('string');
    expect(fieldKind({ type: ['string', 'number'] })).toBe('json');
  });

  it('honours x-widget secret and textarea and long maxLength', () => {
    expect(fieldKind({ type: 'string', 'x-widget': 'secret' })).toBe('secret');
    expect(fieldKind({ type: 'string', 'x-widget': 'textarea' })).toBe('text');
    expect(fieldKind({ type: 'string', maxLength: 500 })).toBe('text');
  });

  it('sends untyped shapes and bare objects to json', () => {
    expect(fieldKind({ type: 'object' })).toBe('json');
    expect(fieldKind({})).toBe('json');
  });

  it('picks variant for real unions, the inner kind for nullable ones', () => {
    expect(fieldKind({ oneOf: [{ type: 'string' }, { type: 'number' }] })).toBe('variant');
    expect(fieldKind({ anyOf: [{ type: 'string' }, { type: 'null' }] })).toBe('string');
    const props = SPEC.properties!;
    expect(fieldKind(props.nullableName!)).toBe('string');
  });

  it('picks objectArray for arrays of objects or variants, record for map objects', () => {
    const props = SPEC.properties!;
    expect(fieldKind(props.tools!)).toBe('objectArray');
    expect(fieldKind(props.triggers!)).toBe('objectArray');
    expect(fieldKind(props.instructionsByFamily!)).toBe('record');
    expect(fieldKind({ type: 'array', items: { type: 'object', properties: {} } })).toBe('objectArray');
    expect(fieldKind({ type: 'object', additionalProperties: true })).toBe('json');
  });
});

describe('humanize', () => {
  it('title-cases camelCase keys and keeps known acronyms', () => {
    expect(humanize('maxOutputTokens')).toBe('Max output tokens');
    expect(humanize('mcpServers')).toBe('MCP servers');
    expect(humanize('approvalTtlMs')).toBe('Approval TTL ms');
    expect(humanize('ttlMs')).toBe('TTL ms');
    expect(humanize('modelSettings')).toBe('Model settings');
    expect(humanize('fallbackModels')).toBe('Fallback models');
  });
});
