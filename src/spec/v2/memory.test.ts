import { describe, it, expect } from 'vitest';
import { ValidationError } from '../../execution/errors';
import { parseAgentSpecV2 } from './parse';
import { agentSpecV2Schema } from './schema';

const base = { version: 2, name: 'support', model: 'anthropic/claude-sonnet-5-5', instructions: 'Help.' };

function spec(memory: unknown) {
  return { ...base, memory };
}

function thrown(data: unknown): ValidationError {
  try {
    parseAgentSpecV2(data);
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error('expected parseAgentSpecV2 to throw');
}

describe('spec v2 memory', () => {
  it('accepts a minimal entry and the full field set', () => {
    const memory = [
      { name: 'notes', scope: 'global', provider: { type: 'in-memory' } },
      {
        name: 'prefs',
        description: 'User preferences',
        scope: 'session',
        provider: { type: 'file', dir: 'memory/prefs', maxItems: 50 },
        recall: { onSessionStart: false, maxItems: 5, query: 'last-input' },
        expose: { remember: true, recall: false, forget: true },
      },
      {
        name: 'facts',
        scope: { metadataKey: 'userId' },
        provider: { type: 'sqlite-vector', path: 'data/memory.db', embedder: 'openai/text-embedding-3-small', maxItems: 500, minScore: 0.3 },
        itemJsonSchema: { type: 'object', properties: { topic: { type: 'string' } } },
        itemKey: 'topic',
      },
    ];
    const result = agentSpecV2Schema.safeParse(spec(memory));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.memory).toEqual(memory);
  });

  it('rejects an unknown provider type at provider.type', () => {
    const error = thrown(spec([{ name: 'notes', scope: 'global', provider: { type: 'redis' } }]));
    expect(error.errors).toHaveProperty('memory.0.provider.type');
  });

  it('rejects duplicate names', () => {
    const error = thrown(
      spec([
        { name: 'notes', scope: 'global', provider: { type: 'in-memory' } },
        { name: 'notes', scope: 'session', provider: { type: 'file', dir: 'mem' } },
      ])
    );
    expect(error.errors).toHaveProperty('memory.1.name');
    expect(error.message).toContain("duplicate memory name 'notes'");
  });

  it('rejects itemKey without itemJsonSchema', () => {
    const error = thrown(spec([{ name: 'notes', scope: 'global', provider: { type: 'in-memory' }, itemKey: 'topic' }]));
    expect(error.errors).toHaveProperty('memory.0.itemKey');
    expect(error.message).toContain('itemKey needs itemJsonSchema');
  });

  it('rejects a name defineMemory would refuse', () => {
    for (const name of ['has space', 'dot.name', 'x'.repeat(56)]) {
      const error = thrown(spec([{ name, scope: 'global', provider: { type: 'in-memory' } }]));
      expect(error.errors).toHaveProperty('memory.0.name');
    }
  });

  it('rejects unknown keys (strict objects)', () => {
    const error = thrown(spec([{ name: 'notes', scope: 'global', provider: { type: 'in-memory' }, recall: { limit: 3 } }]));
    expect(error.errors).toHaveProperty('memory.0.recall');
  });

  it('rejects an out-of-range minScore and a non-positive maxItems', () => {
    const score = thrown(
      spec([{ name: 'notes', scope: 'global', provider: { type: 'sqlite-vector', embedder: 'openai/text-embedding-3-small', minScore: 1.5 } }])
    );
    expect(score.errors).toHaveProperty('memory.0.provider.minScore');
    const items = thrown(spec([{ name: 'notes', scope: 'global', provider: { type: 'in-memory', maxItems: 0 } }]));
    expect(items.errors).toHaveProperty('memory.0.provider.maxItems');
  });
});
