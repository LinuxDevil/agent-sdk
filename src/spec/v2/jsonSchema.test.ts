/**
 * Tests for S17: agentSpecV2JsonSchema export
 */
import { describe, it, expect } from 'vitest';
import { agentSpecV2JsonSchema, SPEC_FIELD_DESCRIPTIONS } from './jsonSchema';
import { agentSpecV2Schema } from './schema';
import { jsonSchemaToZod } from '../../tools/mcp/schema';

describe('agentSpecV2JsonSchema', () => {
  it('returns a draft-7 object schema with required fields', () => {
    const schema = agentSpecV2JsonSchema();
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(schema.title).toBe('AgentSpec v2');
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    const required = schema.required as string[];
    expect(required).toContain('version');
    expect(required).toContain('name');
    expect(required).toContain('model');
    expect(required).toContain('instructions');
  });

  it('has every spec field in properties with a description', () => {
    const schema = agentSpecV2JsonSchema();
    const props = schema.properties as Record<string, Record<string, unknown>>;
    const shape = agentSpecV2Schema.shape;
    for (const key of Object.keys(shape)) {
      expect(props[key]).toBeDefined();
      expect(props[key].description).toBeTruthy();
      expect(typeof props[key].description).toBe('string');
      expect((props[key].description as string).length).toBeGreaterThan(0);
    }
  });

  it('SPEC_FIELD_DESCRIPTIONS has no stale keys', () => {
    const shape = agentSpecV2Schema.shape;
    for (const key of Object.keys(SPEC_FIELD_DESCRIPTIONS)) {
      expect(shape[key]).toBeDefined();
    }
  });

  it('is memoized and frozen', () => {
    const first = agentSpecV2JsonSchema();
    const second = agentSpecV2JsonSchema();
    expect(first).toBe(second);
    expect(() => {
      'use strict';
      (first as Record<string, unknown>).type = 'array';
    }).toThrow();
  });

  it('round-trips a valid spec through jsonSchemaToZod', () => {
    const schema = agentSpecV2JsonSchema();
    const zodSchema = jsonSchemaToZod(schema);
    const validSpec = {
      version: 2,
      name: 'test-agent',
      description: 'A test agent',
      model: 'anthropic/claude-sonnet-5-5',
      instructions: 'You are a helpful assistant.',
      tools: [{ builtin: 'web_fetch' }],
      mcpServers: { myServer: { command: 'node', args: ['server.js'] } },
      guardrails: [{ id: 'g1', name: 'pii' }],
      triggers: [{ id: 'chat', type: 'chat' }],
    };
    const result = zodSchema.safeParse(validSpec);
    if (!result.success) {
      console.log('Parse error:', JSON.stringify(result.error, null, 2));
    }
    expect(result.success).toBe(true);
  });

  it('has the correct property keys snapshot', () => {
    const schema = agentSpecV2JsonSchema();
    const props = schema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toMatchSnapshot();
  });
});
