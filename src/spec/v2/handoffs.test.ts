import { describe, it, expect } from 'vitest';
import { ValidationError } from '../../execution/errors';
import { parseAgentSpecV2 } from './parse';

const base = { version: 2, name: 'support', model: 'anthropic/claude-sonnet-5-5', instructions: 'Help.' };

function spec(handoffs: unknown) {
  return { ...base, handoffs };
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

describe('spec v2 handoffs', () => {
  it('accepts entries with a target, toolName, inputFilter and description', () => {
    const handoffs = [
      { agent: 'billing' },
      { agent: 'refunds', toolName: 'to_refunds', inputFilter: 'removeToolCalls', description: 'Refund questions' },
    ];
    expect(parseAgentSpecV2(spec(handoffs)).handoffs).toEqual(handoffs);
  });

  it('rejects duplicate targets at handoffs.<i>.agent', () => {
    const error = thrown(spec([{ agent: 'billing' }, { agent: 'billing' }]));
    expect(error.message).toContain("duplicate handoff to 'billing'");
    expect(error.errors).toHaveProperty('handoffs.1.agent');
  });

  it('rejects duplicate explicit toolNames at handoffs.<i>.toolName', () => {
    const error = thrown(
      spec([
        { agent: 'a', toolName: 'go' },
        { agent: 'b', toolName: 'go' },
      ])
    );
    expect(error.message).toContain("duplicate toolName 'go'");
    expect(error.errors).toHaveProperty('handoffs.1.toolName');
  });

  it('rejects a bad toolName, a bad inputFilter and an unknown key', () => {
    const badName = thrown(spec([{ agent: 'billing', toolName: 'transfer to billing' }]));
    expect(badName.code).toBe('LOUSHO_SPEC_INVALID');
    expect(badName.errors).toHaveProperty('handoffs.0.toolName');

    const badFilter = thrown(spec([{ agent: 'billing', inputFilter: 'none' }]));
    expect(badFilter.code).toBe('LOUSHO_SPEC_INVALID');
    expect(badFilter.errors).toHaveProperty('handoffs.0.inputFilter');
    expect(badFilter.message).toContain("must be 'removeToolCalls' or 'lastUserMessage'");

    const unknownKey = thrown(spec([{ agent: 'a', filter: 'x' }]));
    expect(unknownKey.code).toBe('LOUSHO_SPEC_INVALID');
    expect(unknownKey.errors).toHaveProperty('handoffs.0');
  });

  it('rejects inputJsonSchema as not supported yet', () => {
    const error = thrown(spec([{ agent: 'a', inputJsonSchema: { type: 'object' } }]));
    expect(error.code).toBe('LOUSHO_SPEC_UNSUPPORTED');
    expect(error.errors).toHaveProperty('handoffs.0.inputJsonSchema');
    expect(error.message).toContain('inputJsonSchema');
  });
});
