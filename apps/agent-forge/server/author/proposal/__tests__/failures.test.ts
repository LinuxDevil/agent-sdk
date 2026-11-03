import { describe, expect, it } from 'vitest';
import type { AuthorToolFailure } from '../../../../shared/authorWire';
import {
  agentGoneFailure,
  alreadySavedFailure,
  ambiguousProposalFailure,
  baseChangedFailure,
  invalidStoredProposalFailure,
  noProposalFailure,
  staleProposalFailure,
  unansweredFailure,
  unknownProposalFailure,
  writeFailedFailure,
  wrongAgentFailure,
} from '../failures';

/**
 * The save gate's copy contract (PLAN §8.3): every refusal carries a
 * model-facing `error` and `next` (which may name tools and ids so the
 * model can recover) and a person-facing `userMessage` in plain words -
 * no camelCase tool names, no proposal ids (`p_`/`call_` prefixes).
 */

const FORBIDDEN_IN_USER_COPY = /[a-z]+[A-Z]\w*|p_|call_/;

const ALL: AuthorToolFailure[] = [
  unansweredFailure('create'),
  unansweredFailure('update'),
  noProposalFailure('create'),
  noProposalFailure('update'),
  alreadySavedFailure(),
  unknownProposalFailure('create', 'call_p1'),
  unknownProposalFailure('update', 'call_p1'),
  staleProposalFailure('call_p1', 'call_p2'),
  wrongAgentFailure('call_u1', 'agent-a', 'agent-b'),
  ambiguousProposalFailure('create', 'call_p1'),
  ambiguousProposalFailure('update', 'call_p1'),
  invalidStoredProposalFailure([{ path: 'model', message: 'Required' }]),
  baseChangedFailure('agent-a'),
  agentGoneFailure('agent-a'),
  writeFailedFailure('disk full'),
];

describe('save-gate failure copy', () => {
  it('every failure is a returned refusal with non-empty error, userMessage and next', () => {
    for (const failure of ALL) {
      expect(failure.ok).toBe(false);
      expect(failure.error.length).toBeGreaterThan(0);
      expect(failure.userMessage.length).toBeGreaterThan(0);
      expect(failure.next?.length).toBeGreaterThan(0);
    }
  });

  it('no userMessage contains a tool name or an id', () => {
    for (const failure of ALL) {
      expect(failure.userMessage).not.toMatch(FORBIDDEN_IN_USER_COPY);
    }
  });

  it('each builder carries its code', () => {
    expect(unansweredFailure('create').code).toBe('UNANSWERED');
    expect(noProposalFailure('create').code).toBe('NO_PROPOSAL');
    expect(alreadySavedFailure().code).toBe('ALREADY_SAVED');
    expect(unknownProposalFailure('create', 'call_p1').code).toBe('UNKNOWN_PROPOSAL');
    expect(staleProposalFailure('call_p1', 'call_p2').code).toBe('STALE_PROPOSAL');
    expect(wrongAgentFailure('call_u1', 'agent-a', 'agent-b').code).toBe('WRONG_AGENT');
    expect(ambiguousProposalFailure('create', 'call_p1').code).toBe('AMBIGUOUS_PROPOSAL');
    expect(invalidStoredProposalFailure([{ path: 'model', message: 'Required' }]).code).toBe(
      'INVALID_STORED_PROPOSAL'
    );
    expect(baseChangedFailure('agent-a').code).toBe('BASE_CHANGED');
    expect(agentGoneFailure('agent-a').code).toBe('AGENT_GONE');
    expect(writeFailedFailure('disk full').code).toBe('WRITE_FAILED');
  });

  it('the model copy interpolates the proposal ids it names', () => {
    expect(unknownProposalFailure('create', 'call_p1').error).toContain('"call_p1"');
    const stale = staleProposalFailure('call_p1', 'call_p2');
    expect(stale.error).toContain('"call_p1"');
    expect(stale.error).toContain('"call_p2"');
    expect(stale.latestProposalId).toBe('call_p2');
    expect(wrongAgentFailure('call_u1', 'agent-a', 'agent-b').error).toContain('"agent-a"');
    expect(wrongAgentFailure('call_u1', 'agent-a', 'agent-b').error).toContain('"agent-b"');
    expect(ambiguousProposalFailure('create', 'call_p1').error).toContain('"call_p1"');
  });

  it('the next step names the kind\'s propose tool so the model knows what to call', () => {
    expect(noProposalFailure('create').next).toContain('Call proposeAgent,');
    expect(noProposalFailure('update').next).toContain('Call proposeAgentUpdate,');
    expect(unknownProposalFailure('create', 'p1').next).toContain('proposeAgent result');
    expect(unknownProposalFailure('update', 'p1').next).toContain('proposeAgentUpdate result');
    expect(ambiguousProposalFailure('update', 'p1').next).toContain('Call proposeAgentUpdate again');
  });
});
