import { describe, it, expect, vi } from 'vitest';
import { createAgent, type SimpleAgent } from '../../../createAgent';
import { ConfigurationError } from '../../../execution/errors';
import { mockModel } from '../../../testing';
import type { AgentSpecV2, InlineAgentSpec } from '../types';
import { isRemoteSubagent } from '../../../subagents/remoteAgent';
import type { RemoteSubagent } from '../../../subagents/types';
import { subagentFromSpec, type SubagentHost } from './subagents';

const research: InlineAgentSpec = {
  name: 'research',
  description: 'Finds sources',
  model: 'openai/gpt-4o-mini',
  instructions: 'Research.',
};

/** A SubagentHost whose buildAgent makes a real (mock-model) agent, like S16's compiler will. */
function fakeHost(extra: Partial<SubagentHost> = {}): SubagentHost {
  return {
    buildAgent: vi.fn(async (spec: InlineAgentSpec, name: string): Promise<SimpleAgent> =>
      createAgent({ name, description: spec.description, provider: mockModel(['ok']), instructions: 'x' })
    ),
    ...extra,
  };
}

/** Narrows `agent` to a SimpleAgent (the `{ inline }` and `{ ref }` forms build one). */
function asLocal(agent: SimpleAgent | RemoteSubagent): SimpleAgent {
  if (isRemoteSubagent(agent)) throw new Error('expected a local sub-agent');
  return agent;
}

async function catchError(promise: Promise<unknown>): Promise<ConfigurationError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConfigurationError) return error;
    throw error;
  }
  throw new Error('expected the promise to reject');
}

describe('subagentFromSpec { inline }', () => {
  it('builds the inline spec through the host, under sub:<name>', async () => {
    const host = fakeHost();
    const result = await subagentFromSpec('research', { inline: research }, host);
    expect(host.buildAgent).toHaveBeenCalledWith(research, 'research', 'sub:research');
    expect(typeof asLocal(result).send).toBe('function');
  });
});

describe('subagentFromSpec { ref }', () => {
  it('rejects a host that cannot load agent files', async () => {
    const error = await catchError(subagentFromSpec('billing', { ref: 'agents/billing.yaml' }, fakeHost()));
    expect(error.code).toBe('LOUSHO_SPEC_UNSUPPORTED');
    expect(error.field).toBe('subagents.billing.ref');
  });

  it('loads the ref and builds it without the top-level-only keys', async () => {
    const loaded = {
      version: 2,
      name: 'b',
      description: 'Billing',
      model: 'mock/m',
      instructions: 'x',
      triggers: [],
      flow: undefined,
      evals: [],
    } as unknown as AgentSpecV2;
    const loadAgentRef = vi.fn(async () => loaded);
    const host = fakeHost({ loadAgentRef });
    const result = await subagentFromSpec('billing', { ref: 'agents/billing.yaml' }, host);
    expect(loadAgentRef).toHaveBeenCalledWith('agents/billing.yaml');
    expect(host.buildAgent).toHaveBeenCalledWith(
      { name: 'b', description: 'Billing', model: 'mock/m', instructions: 'x' },
      'billing',
      'sub:billing'
    );
    expect(typeof asLocal(result).send).toBe('function');
  });

  it('rejects a loaded spec with no description', async () => {
    const loaded = { version: 2, name: 'b', model: 'mock/m', instructions: 'x' } as AgentSpecV2;
    const host = fakeHost({ loadAgentRef: async () => loaded });
    const error = await catchError(subagentFromSpec('billing', { ref: 'agents/billing.yaml' }, host));
    expect(error.code).toBe('LOUSHO_SPEC_INVALID');
    expect(error.field).toBe('subagents.billing.ref');
    expect(host.buildAgent).not.toHaveBeenCalled();
  });
});

describe('subagentFromSpec { remote }', () => {
  const remote = { url: 'https://agents.example.com/support', auth: { env: 'T' }, description: 'Support' } as const;

  it('returns a remote sub-agent without calling the network', async () => {
    const host = fakeHost({ env: { T: 'tok' } });
    const result = await subagentFromSpec('api', { remote: remote }, host);
    if (!isRemoteSubagent(result)) throw new Error('expected a remote sub-agent');
    expect(result.description).toBe('Support');
    expect(typeof result.run).toBe('function');
    expect(host.buildAgent).not.toHaveBeenCalled();
  });

  it('fails fast when the auth secret is missing', async () => {
    const host = fakeHost({ env: {} });
    const error = await catchError(subagentFromSpec('api', { remote: remote }, host));
    expect(error.code).toBe('LOUSHO_SPEC_SECRET_MISSING');
    expect(error.field).toBe('subagents.api.remote.auth');
  });
});
