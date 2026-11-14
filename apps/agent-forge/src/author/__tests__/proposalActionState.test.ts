import { describe, it, expect } from 'vitest';
import type {
  AuthorAssistantMessage,
  AuthorToolPart,
  AuthorUserMessage,
} from '../../../shared/authorWire';
import { cardState, proposalActionState } from '../proposalActionState';

let toolSeq = 0;
let msgSeq = 0;

function tool(over: Partial<AuthorToolPart>): AuthorToolPart {
  return {
    type: 'tool',
    toolCallId: `tc_${++toolSeq}`,
    name: 'proposeAgent',
    input: {},
    state: 'done',
    ...over,
  };
}

/** An ok propose part; `kind` and `agentId` ride on the output like ProposalOutput's. */
function propose(id: string, kind: 'create' | 'update' = 'create', agentId?: string): AuthorToolPart {
  return tool({
    toolCallId: id,
    name: kind === 'create' ? 'proposeAgent' : 'proposeAgentUpdate',
    output: {
      ok: true,
      proposalId: id,
      kind,
      ...(agentId !== undefined ? { agentId } : {}),
      spec: { version: 2, name: 'x', model: 'm', instructions: 'i' },
      changes: [],
      requirements: [],
      carriedOver: false,
      carriedFields: [],
      baseSpecHash: null,
      enabled: false,
    },
  });
}

/** An ok save/discard part. */
function resultPart(name: string, output: unknown, id?: string): AuthorToolPart {
  return tool({ toolCallId: id ?? `tc_${name}`, name, output });
}

function assistant(parts: AuthorToolPart[]): AuthorAssistantMessage {
  return { id: `m_a_${++msgSeq}`, role: 'assistant', parts, at: '2026-01-01T00:00:00.000Z' };
}

function saveEvent(proposalId: string): AuthorUserMessage {
  return {
    id: `m_u_${++msgSeq}`,
    role: 'user',
    text: '',
    at: '2026-01-01T00:00:00.000Z',
    uiEvent: { kind: 'save', proposalId, agentId: 'a1', version: 1 },
  };
}

const okDiscard = (output: unknown) => resultPart('discardPendingChanges', output);
const okSave = (name: 'saveAgent' | 'saveAgentUpdate') => resultPart(name, { ok: true, agentId: 'a1', version: 1, name: 'x', enabled: false });

describe('proposalActionState', () => {
  it('an ok proposeAgent part is actionable and visible; the previous unsaved create leaves visibleCreate', () => {
    const s = proposalActionState([assistant([propose('p1')]), assistant([propose('p2')])]);
    expect(s.actionableProposalId).toBe('p2');
    expect(s.visibleCreateProposalIds.has('p1')).toBe(false);
    expect(s.visibleCreateProposalIds.has('p2')).toBe(true);
  });

  it('a pending or failed propose part does nothing', () => {
    const busy = tool({ toolCallId: 'p1', name: 'proposeAgent', state: 'pending', output: undefined });
    const failed = tool({
      toolCallId: 'p2',
      name: 'proposeAgentUpdate',
      output: { ok: false, code: 'DRAFT_INVALID', error: 'e', userMessage: 'u' },
    });
    const s = proposalActionState([assistant([busy, failed])]);
    expect(s.actionableProposalId).toBeNull();
    expect(s.visibleCreateProposalIds.size).toBe(0);
  });

  it('an ok proposeAgentUpdate part is actionable', () => {
    const s = proposalActionState([assistant([propose('u1', 'update', 'agent-1')])]);
    expect(s.actionableProposalId).toBe('u1');
    expect(s.visibleCreateProposalIds.size).toBe(0);
  });

  it('an ok save part retires the actionable card to saved', () => {
    const s = proposalActionState([assistant([propose('p1'), okSave('saveAgent')])]);
    expect(s.actionableProposalId).toBeNull();
    expect(s.savedProposalIds.has('p1')).toBe(true);
    // A saved create stays visible (it renders "Saved").
    expect(s.visibleCreateProposalIds.has('p1')).toBe(true);
  });

  it('an ok save part with no open card saves nothing', () => {
    const s = proposalActionState([assistant([okSave('saveAgent')])]);
    expect(s.savedProposalIds.size).toBe(0);
  });

  it('a save uiEvent marks that proposal saved and clears it when actionable', () => {
    const s = proposalActionState([assistant([propose('p1')]), saveEvent('p1')]);
    expect(s.savedProposalIds.has('p1')).toBe(true);
    expect(s.actionableProposalId).toBeNull();
  });

  it('a save uiEvent for a non-actionable card still records the save', () => {
    const s = proposalActionState([assistant([propose('p1'), propose('p2')]), saveEvent('p1')]);
    expect(s.savedProposalIds.has('p1')).toBe(true);
    expect(s.actionableProposalId).toBe('p2');
  });

  it('a newer create after the previous create saved leaves the saved card visible', () => {
    const s = proposalActionState([assistant([propose('p1'), okSave('saveAgent')]), assistant([propose('p2')])]);
    expect(s.visibleCreateProposalIds.has('p1')).toBe(true);
    expect(s.visibleCreateProposalIds.has('p2')).toBe(true);
    expect(s.actionableProposalId).toBe('p2');
  });

  it('an ok discard with no agentId discards every unsaved create card, saved ones survive', () => {
    const s = proposalActionState([
      assistant([propose('p1'), okSave('saveAgent')]),
      assistant([propose('p2'), okDiscard({ ok: true, message: 'm' })]),
    ]);
    expect(s.discardedProposalIds.has('p2')).toBe(true);
    expect(s.discardedProposalIds.has('p1')).toBe(false);
    expect(s.savedProposalIds.has('p1')).toBe(true);
    expect(s.actionableProposalId).toBeNull();
  });

  it('an ok discard with agentId discards only that agent\'s unsaved update cards', () => {
    const s = proposalActionState([
      assistant([
        propose('u1', 'update', 'agent-1'),
        propose('u2', 'update', 'agent-2'),
        okDiscard({ ok: true, agentId: 'agent-1', message: 'm' }),
      ]),
    ]);
    expect(s.discardedProposalIds.has('u1')).toBe(true);
    expect(s.discardedProposalIds.has('u2')).toBe(false);
    expect(s.actionableProposalId).toBe('u2');
  });

  it('a discard that retires the actionable card clears actionable', () => {
    const s = proposalActionState([assistant([propose('p1'), okDiscard({ ok: true, message: 'm' })])]);
    expect(s.actionableProposalId).toBeNull();
    expect(s.discardedProposalIds.has('p1')).toBe(true);
  });

  it('a pending requestSecret part sets hasPendingClientRequest; a settled one does not', () => {
    const pending = tool({ toolCallId: 's1', name: 'requestSecret', state: 'pending', input: { name: 'X' } });
    const settled = tool({
      toolCallId: 's2',
      name: 'requestSecret',
      state: 'done',
      output: { ok: true, name: 'Y', status: 'saved' },
    });
    expect(proposalActionState([assistant([pending])]).hasPendingClientRequest).toBe(true);
    expect(proposalActionState([assistant([settled])]).hasPendingClientRequest).toBe(false);
  });

  it('mixed create and update cards: the last ok propose wins actionable', () => {
    const s = proposalActionState([
      assistant([propose('p1')]),
      assistant([propose('u1', 'update', 'agent-1')]),
      assistant([propose('p2')]),
    ]);
    expect(s.actionableProposalId).toBe('p2');
    expect(cardState('u1', s)).toBe('superseded');
    expect(cardState('p1', s)).toBe('superseded');
    expect(cardState('p2', s)).toBe('actionable');
  });

  it('the active assistant message continues the settled walk', () => {
    const active = assistant([propose('p2')]);
    const s = proposalActionState([assistant([propose('p1')])], active);
    expect(s.actionableProposalId).toBe('p2');
    expect(s.visibleCreateProposalIds.has('p1')).toBe(false);
  });
});

describe('cardState', () => {
  it('saved, discarded, actionable and superseded in that order', () => {
    const s = proposalActionState([
      assistant([propose('gone')]),
      assistant([propose('kept'), okSave('saveAgent')]),
      assistant([propose('fresh')]),
      saveEvent('kept'),
    ]);
    expect(cardState('kept', s)).toBe('saved');
    expect(cardState('fresh', s)).toBe('actionable');
    expect(cardState('gone', s)).toBe('superseded');
    const s2 = proposalActionState([assistant([propose('d1'), okDiscard({ ok: true, message: 'm' })])]);
    expect(cardState('d1', s2)).toBe('discarded');
  });
});
