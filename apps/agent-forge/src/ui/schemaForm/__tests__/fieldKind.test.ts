import { describe, expect, it } from 'vitest';

import { fieldKind, humanize } from '../fieldKind';
import { resolveRef } from '../schemaPath';

import { SCHEMA } from './fixture';

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

  it('sends oneOf, object arrays, property-less objects and untyped shapes to json', () => {
    expect(fieldKind({ oneOf: [{ type: 'string' }] })).toBe('json');
    expect(fieldKind({ anyOf: [{ type: 'string' }, { type: 'number' }] })).toBe('json');
    expect(fieldKind({ type: 'array', items: { type: 'object', properties: {} } })).toBe('json');
    expect(fieldKind({ type: 'object' })).toBe('json');
    expect(fieldKind({})).toBe('json');
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
