import { describe, it, expect } from 'vitest';
import type {
  AuthorAssistantMessage,
  AuthorMessage,
  AuthorToolPart,
  AuthorUserMessage,
  ProposalOutput,
} from '../../../shared/authorWire';
import { findProposalOutput, lastEnabledOutput, saveOutputOf } from '../savedProposal';

let seq = 0;
function tool(over: Partial<AuthorToolPart>): AuthorToolPart {
  return { type: 'tool', toolCallId: `tc_${++seq}`, name: 'getCurrentSpec', input: {}, state: 'done', ...over };
}

function assistant(parts: AuthorAssistantMessage['parts']): AuthorAssistantMessage {
  return { id: `m_a_${++seq}`, role: 'assistant', parts, at: '2026-01-01T00:00:00.000Z' };
}

function user(text: string, uiEvent?: AuthorUserMessage['uiEvent']): AuthorUserMessage {
  return {
    id: `m_u_${++seq}`,
    role: 'user',
    text,
    at: '2026-01-01T00:00:00.000Z',
    ...(uiEvent !== undefined ? { uiEvent } : {}),
  };
}

function proposal(over: Partial<ProposalOutput> = {}): ProposalOutput {
  return {
    ok: true,
    proposalId: 'tc_prop',
    kind: 'create',
    spec: { version: 2, name: 'Triage bot', model: 'anthropic/claude-sonnet-5-5', instructions: 'Triage issues.' },
    changes: [],
    requirements: [],
    carriedOver: false,
    carriedFields: [],
    baseSpecHash: null,
    enabled: false,
    ...over,
  };
}

describe('findProposalOutput', () => {
  it('returns the ok propose part output with the matching toolCallId', () => {
    const messages: AuthorMessage[] = [
      user('Build me a bot'),
      assistant([
        { type: 'text', text: 'Here.' },
        tool({ toolCallId: 'tc_prop', name: 'proposeAgent', output: proposal() }),
      ]),
    ];
    expect(findProposalOutput(messages, null, 'tc_prop')?.spec.name).toBe('Triage bot');
  });

  it('finds the card in the live assistant message', () => {
    const active = assistant([
      tool({ toolCallId: 'tc_prop', name: 'proposeAgentUpdate', output: proposal({ kind: 'update', agentId: 'a1' }) }),
    ]);
    expect(findProposalOutput([], active, 'tc_prop')?.kind).toBe('update');
  });

  it('ignores failed, busy and differently-named parts', () => {
    const messages: AuthorMessage[] = [
      assistant([
        tool({ toolCallId: 'tc_prop', name: 'proposeAgent', output: { ok: false } }),
        tool({ toolCallId: 'tc_prop2', name: 'proposeAgent', state: 'pending' }),
        tool({ toolCallId: 'tc_prop3', name: 'saveAgent', output: proposal() }),
      ]),
    ];
    expect(findProposalOutput(messages, null, 'tc_prop')).toBeNull();
    expect(findProposalOutput(messages, null, 'tc_prop2')).toBeNull();
    expect(findProposalOutput(messages, null, 'tc_prop3')).toBeNull();
    expect(findProposalOutput(messages, null, 'tc_missing')).toBeNull();
  });
});

describe('lastEnabledOutput', () => {
  const enabledOut = (agentId: string, enabled: boolean) => ({
    ok: true,
    agentId,
    enabled,
    status: 'updated',
    missingRequirements: 0,
  });

  it('returns the newest ok setAgentEnabled output for the agent', () => {
    const messages: AuthorMessage[] = [
      assistant([tool({ name: 'setAgentEnabled', output: enabledOut('a1', true) })]),
      assistant([tool({ name: 'setAgentEnabled', output: enabledOut('a1', false) })]),
      assistant([tool({ name: 'setAgentEnabled', output: enabledOut('a2', true) })]),
    ];
    expect(lastEnabledOutput(messages, null, 'a1')?.enabled).toBe(false);
    expect(lastEnabledOutput(messages, null, 'a2')?.enabled).toBe(true);
    expect(lastEnabledOutput(messages, null, 'a3')).toBeNull();
  });

  it('scans the live message too and skips failed parts', () => {
    const messages: AuthorMessage[] = [
      assistant([tool({ name: 'setAgentEnabled', output: { ok: false, code: 'BUSY' } })]),
    ];
    const active = assistant([tool({ name: 'setAgentEnabled', output: enabledOut('a1', true) })]);
    expect(lastEnabledOutput(messages, active, 'a1')?.enabled).toBe(true);
  });
});

describe('saveOutputOf', () => {
  it('reads the ok save result fields', () => {
    const part = tool({
      name: 'saveAgent',
      output: { ok: true, agentId: 'triage-bot', name: 'Triage bot', version: 1, enabled: false },
    });
    expect(saveOutputOf(part)).toEqual({ agentId: 'triage-bot', name: 'Triage bot', version: 1 });
  });

  it('rejects failed saves and missing fields', () => {
    expect(saveOutputOf(tool({ name: 'saveAgent', output: { ok: false } }))).toBeNull();
    expect(saveOutputOf(tool({ name: 'saveAgent', output: { ok: true, agentId: 'a' } }))).toBeNull();
    expect(saveOutputOf(tool({ name: 'saveAgent', state: 'pending' }))).toBeNull();
  });
});
