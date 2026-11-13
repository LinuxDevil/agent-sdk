import { describe, expect, it } from 'vitest';
import type { AgentSpecV2 } from '@linuxdevil/lousho';
import type {
  AuthorAssistantMessage,
  AuthorMessage,
  AuthorToolFailure,
  AuthorToolPart,
  AuthorUserMessage,
  ProposalOutput,
} from '../../../../shared/authorWire';
import type { AuthorTurn } from '../../turnRunner';
import { identityKey, proposalTurnState, type ProposalIdentity } from '../turnState';
import {
  identityOfProposal,
  openProposalCards,
  resolveStoredProposal,
  saveBlockingError,
  transcriptProposalStatus,
} from '../gate';

/**
 * The AA10a save-gate table (one `it` per row): T is the stored transcript
 * (ending at the previous turn), S is this turn's ProposalTurnState. The
 * fixture builders mirror the ticket's `user`/`assistant`/`okPart` set
 * plus `propose`/`proposeUpdate`/`saveEvent` conveniences.
 */

const AT = '2026-01-01T00:00:00.000Z';
const CREATE: ProposalIdentity = { kind: 'create' };

let seq = 0;

function update(agentId: string): ProposalIdentity {
  return { kind: 'update', agentId };
}

function user(text: string): AuthorUserMessage {
  seq += 1;
  return { id: `m-${seq}`, role: 'user', text, at: AT };
}

/** The app-written user message a card's Apply button appends. */
function saveEvent(proposalId: string, agentId = 'agent-1'): AuthorUserMessage {
  return { ...user(''), uiEvent: { kind: 'save', proposalId, agentId, version: 1 } };
}

function assistant(...parts: AuthorAssistantMessage['parts']): AuthorAssistantMessage {
  seq += 1;
  return { id: `m-${seq}`, role: 'assistant', parts, at: AT };
}

function okPart(
  name: string,
  toolCallId: string,
  input: unknown = {},
  output: unknown = { ok: true }
): AuthorToolPart {
  return { type: 'tool', toolCallId, name, input, output, state: 'done' };
}

function spec(name: string): AgentSpecV2 {
  return {
    version: 2,
    name,
    description: 'does a thing',
    model: 'anthropic/claude-sonnet-5-5',
    instructions: 'do a thing',
  };
}

function card(proposalId: string, over: Partial<ProposalOutput> = {}): ProposalOutput {
  return {
    ok: true,
    proposalId,
    kind: 'create',
    spec: spec(`Agent ${proposalId}`),
    changes: [],
    requirements: [],
    carriedOver: false,
    carriedFields: [],
    baseSpecHash: null,
    enabled: false,
    ...over,
  };
}

/** A successful `proposeAgent` tool part: the card for a new agent. */
function propose(toolCallId: string): AuthorToolPart {
  return okPart('proposeAgent', toolCallId, { draft: { name: `Agent ${toolCallId}` } }, card(toolCallId));
}

/** A successful `proposeAgentUpdate` tool part: the card editing `agentId`. */
function proposeUpdate(toolCallId: string, agentId: string): AuthorToolPart {
  return okPart(
    'proposeAgentUpdate',
    toolCallId,
    { agentId, patch: {} },
    card(toolCallId, { kind: 'update', agentId, spec: spec(`Agent ${agentId}`) })
  );
}

function turn(transcript: AuthorMessage[]): AuthorTurn {
  return {
    sessionId: 'sess-1',
    requestId: 'req-1',
    focus: { mode: 'create' },
    storedTranscript: transcript,
    userMessage: user('hi'),
    signal: new AbortController().signal,
    stepsRemaining: () => 12,
    state: new Map(),
  };
}

function codeOf(result: AuthorToolFailure | null): string {
  expect(result).not.toBeNull();
  return result!.code;
}

describe('saveBlockingError', () => {
  it('1. empty transcript and empty turn state -> NO_PROPOSAL', () => {
    expect(codeOf(saveBlockingError(turn([]), CREATE))).toBe('NO_PROPOSAL');
  });

  it('2. card proposed this turn -> UNANSWERED', () => {
    const t = turn([]);
    proposalTurnState(t).proposed.set(identityKey(CREATE), card('p2'));
    expect(codeOf(saveBlockingError(t, CREATE))).toBe('UNANSWERED');
  });

  it('3. an open stored card -> null', () => {
    expect(saveBlockingError(turn([assistant(propose('p1'))]), CREATE)).toBeNull();
  });

  it('4. card saved by a saveAgent tool call -> ALREADY_SAVED', () => {
    const t = [assistant(propose('p1'), okPart('saveAgent', 's1'))];
    expect(codeOf(saveBlockingError(turn(t), CREATE))).toBe('ALREADY_SAVED');
  });

  it('5. card saved by the user\'s Apply button (uiEvent) -> ALREADY_SAVED', () => {
    const t = [assistant(propose('p1')), saveEvent('p1')];
    expect(codeOf(saveBlockingError(turn(t), CREATE))).toBe('ALREADY_SAVED');
  });

  it('6. card saved earlier this turn (S.saved) -> ALREADY_SAVED', () => {
    const t = turn([assistant(propose('p1'))]);
    proposalTurnState(t).saved.add(identityKey(CREATE));
    expect(codeOf(saveBlockingError(t, CREATE))).toBe('ALREADY_SAVED');
  });

  it('7. card discarded in the stored transcript -> NO_PROPOSAL', () => {
    const t = [assistant(propose('p1'), okPart('discardPendingChanges', 'd1', {}))];
    expect(codeOf(saveBlockingError(turn(t), CREATE))).toBe('NO_PROPOSAL');
  });

  it('8. card discarded this turn (S.discarded) -> NO_PROPOSAL', () => {
    const t = turn([assistant(propose('p1'))]);
    proposalTurnState(t).discarded.add(identityKey(CREATE));
    expect(codeOf(saveBlockingError(t, CREATE))).toBe('NO_PROPOSAL');
  });

  it('9. an open stored card plus a new card this turn -> UNANSWERED', () => {
    const t = turn([assistant(propose('p1'))]);
    proposalTurnState(t).proposed.set(identityKey(CREATE), card('p2'));
    expect(codeOf(saveBlockingError(t, CREATE))).toBe('UNANSWERED');
  });

  it('10. an update card for agent A never authorises a save for agent B -> NO_PROPOSAL', () => {
    const t = [assistant(proposeUpdate('u1', 'agent-a'))];
    expect(codeOf(saveBlockingError(turn(t), update('agent-b')))).toBe('NO_PROPOSAL');
  });

  it('11. a discard for agent B leaves agent A\'s card open -> null', () => {
    const t = [
      assistant(proposeUpdate('u1', 'agent-a'), okPart('discardPendingChanges', 'd1', { agentId: 'agent-b' })),
    ];
    expect(saveBlockingError(turn(t), update('agent-a'))).toBeNull();
  });

  it('12. a failed propose part (ok:false output) is not a card -> NO_PROPOSAL', () => {
    const failed: AuthorToolPart = {
      type: 'tool',
      toolCallId: 'p1',
      name: 'proposeAgent',
      input: { draft: {} },
      output: { ok: false, code: 'DRAFT_REVIEW', error: 'gaps', userMessage: 'fix it' },
      state: 'done',
    };
    expect(codeOf(saveBlockingError(turn([assistant(failed)]), CREATE))).toBe('NO_PROPOSAL');
  });
});

describe('resolveStoredProposal', () => {
  it('13. an older card is STALE_PROPOSAL and names the newest id', () => {
    const t = [assistant(propose('p1'), propose('p2'))];
    const r = resolveStoredProposal(t, CREATE, 'p1');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('STALE_PROPOSAL');
      expect(r.latestProposalId).toBe('p2');
    }
  });

  it('14. the newest card resolves to its stored input and output', () => {
    const p2 = propose('p2');
    const t = [assistant(propose('p1'), p2)];
    expect(resolveStoredProposal(t, CREATE, 'p2')).toEqual({
      ok: true,
      proposalId: 'p2',
      input: p2.input,
      output: p2.output,
    });
  });

  it('15. an id no tool call used is UNKNOWN_PROPOSAL', () => {
    const t = [assistant(propose('p1'))];
    expect(codeOf(resolveStoredProposal(t, CREATE, 'nope') as AuthorToolFailure)).toBe('UNKNOWN_PROPOSAL');
  });

  it('16. an update card is UNKNOWN_PROPOSAL for the create save', () => {
    const t = [assistant(proposeUpdate('u1', 'agent-a'))];
    expect(codeOf(resolveStoredProposal(t, CREATE, 'u1') as AuthorToolFailure)).toBe('UNKNOWN_PROPOSAL');
  });

  it('17. a card for agent A resolved under agent B is WRONG_AGENT', () => {
    const t = [assistant(proposeUpdate('u1', 'agent-a'))];
    expect(codeOf(resolveStoredProposal(t, update('agent-b'), 'u1') as AuthorToolFailure)).toBe('WRONG_AGENT');
  });

  it('18. a toolCallId on more than one tool part is AMBIGUOUS_PROPOSAL', () => {
    const t = [assistant(propose('p1'), okPart('getCurrentSpec', 'p1', { agentId: 'agent-a' }))];
    expect(codeOf(resolveStoredProposal(t, CREATE, 'p1') as AuthorToolFailure)).toBe('AMBIGUOUS_PROPOSAL');
  });

  it('19. a saved card cannot be saved again -> ALREADY_SAVED', () => {
    const t = [assistant(propose('p1'), okPart('saveAgent', 's1'))];
    expect(codeOf(resolveStoredProposal(t, CREATE, 'p1') as AuthorToolFailure)).toBe('ALREADY_SAVED');
  });

  it('20. a discarded card is gone -> NO_PROPOSAL', () => {
    const t = [assistant(propose('p1'), okPart('discardPendingChanges', 'd1', {}))];
    expect(codeOf(resolveStoredProposal(t, CREATE, 'p1') as AuthorToolFailure)).toBe('NO_PROPOSAL');
  });
});

describe('transcriptProposalStatus', () => {
  it('21. a uiEvent save for a different proposalId leaves the card open', () => {
    const t = [assistant(propose('p1')), saveEvent('other-id')];
    expect(transcriptProposalStatus(t, CREATE)).toEqual({ state: 'open', latestProposalId: 'p1' });
  });
});

describe('openProposalCards', () => {
  it('22. update cards for two agents are both open, oldest first', () => {
    const t = [assistant(proposeUpdate('u1', 'agent-a'), proposeUpdate('u2', 'agent-b'))];
    expect(openProposalCards(t)).toEqual([
      { proposalId: 'u1', kind: 'update', agentId: 'agent-a', name: 'Agent agent-a' },
      { proposalId: 'u2', kind: 'update', agentId: 'agent-b', name: 'Agent agent-b' },
    ]);
  });

  it('23. a saved create card drops out; a later update card stays', () => {
    const t = [
      assistant(propose('p1'), okPart('saveAgent', 's1')),
      assistant(proposeUpdate('u1', 'new-agent')),
    ];
    expect(openProposalCards(t)).toEqual([
      { proposalId: 'u1', kind: 'update', agentId: 'new-agent', name: 'Agent new-agent' },
    ]);
  });
});

describe('identityOfProposal', () => {
  const t = [assistant(propose('p1'), proposeUpdate('u1', 'agent-a'))];

  it('24. maps a proposalId to its identity, or null', () => {
    expect(identityOfProposal(t, 'p1')).toEqual({ kind: 'create' });
    expect(identityOfProposal(t, 'u1')).toEqual({ kind: 'update', agentId: 'agent-a' });
    expect(identityOfProposal(t, 'x')).toBeNull();
  });
});
