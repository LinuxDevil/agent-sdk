import { describe, it, expect } from 'vitest';
import { createAgent, type SimpleAgent } from '../../../createAgent';
import { ConfigurationError } from '../../../execution/errors';
import { handoffFilters, isHandoff } from '../../../handoffs';
import { mockModel } from '../../../testing';
import { handoffFromSpec, type HandoffHost } from './handoffs';

const billing = createAgent({ name: 'billing', description: 'Billing', provider: mockModel(['ok']), instructions: 'x' });

function hostWith(agent: SimpleAgent): HandoffHost {
  return { resolveHandoffAgent: async () => agent };
}

describe('handoffFromSpec', () => {
  it('builds a bare handoff with no options', async () => {
    const result = await handoffFromSpec({ agent: 'billing' }, hostWith(billing), 0);
    expect(isHandoff(result)).toBe(true);
    expect(result.target).toBe(billing);
    expect(result.options).toEqual({});
  });

  it('maps toolName, description and the named inputFilter', async () => {
    const result = await handoffFromSpec(
      { agent: 'billing', inputFilter: 'lastUserMessage', toolName: 'to_billing', description: 'Billing questions' },
      hostWith(billing),
      1
    );
    expect(result.options.inputFilter).toBe(handoffFilters.lastUserMessage);
    expect(result.options.toolName).toBe('to_billing');
    expect(result.options.description).toBe('Billing questions');
  });

  it('rejects a host that cannot resolve handoff targets', async () => {
    const error = await handoffFromSpec({ agent: 'billing' }, {}, 0).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as ConfigurationError).code).toBe('LOUSHO_SPEC_UNSUPPORTED');
    expect((error as ConfigurationError).field).toBe('handoffs.0');
  });

  it('propagates a resolveHandoffAgent rejection', async () => {
    const boom = new Error('no such agent');
    const host: HandoffHost = {
      resolveHandoffAgent: async () => {
        throw boom;
      },
    };
    await expect(handoffFromSpec({ agent: 'billing' }, host, 0)).rejects.toBe(boom);
  });
});
