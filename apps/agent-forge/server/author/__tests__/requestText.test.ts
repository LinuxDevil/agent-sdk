import { describe, expect, it } from 'vitest';
import type {
  AuthorAssistantMessage,
  AuthorMessage,
  AuthorUserMessage,
} from '../../../shared/authorWire';
import { requestTextForProposal } from '../requestText';

function userMsg(text: string, id = 'm_u1'): AuthorUserMessage {
  return { id, role: 'user', text, at: '2026-01-01T00:00:00.000Z' };
}

function uiSave(proposalId: string): AuthorUserMessage {
  return {
    id: 'm_ui',
    role: 'user',
    text: '',
    at: '2026-01-01T00:01:00.000Z',
    uiEvent: { kind: 'save', proposalId, agentId: 'a', version: 1 },
  };
}

function assistantCard(proposalId: string): AuthorAssistantMessage {
  return {
    id: 'm_a1',
    role: 'assistant',
    parts: [
      { type: 'tool', toolCallId: proposalId, name: 'proposeAgent', input: { draft: {} }, output: { ok: true }, state: 'done' },
    ],
    at: '2026-01-01T00:02:00.000Z',
  };
}

describe('requestTextForProposal', () => {
  it('picks the user text of the turn the proposal was made in', () => {
    const messages: AuthorMessage[] = [
      userMsg('first ask', 'm_u1'),
      assistantCard('call_older'),
      userMsg('second ask', 'm_u2'),
      assistantCard('call_p1'),
    ];
    expect(requestTextForProposal(messages, 'call_p1')).toBe('second ask');
    expect(requestTextForProposal(messages, 'call_older')).toBe('first ask');
  });

  it('picks the first message when the proposal sits in turn one', () => {
    const messages: AuthorMessage[] = [userMsg('build me a bot'), assistantCard('call_p1')];
    expect(requestTextForProposal(messages, 'call_p1')).toBe('build me a bot');
  });

  it('skips uiEvent user messages - they are app markers, not asks', () => {
    const withUi: AuthorMessage[] = [userMsg('the real ask'), uiSave('call_p0'), assistantCard('call_p1')];
    expect(requestTextForProposal(withUi, 'call_p1')).toBe('the real ask');
    const onlyUi: AuthorMessage[] = [uiSave('call_p0'), assistantCard('call_p1')];
    expect(requestTextForProposal(onlyUi, 'call_p1')).toBeNull();
  });

  it('returns null for an unknown proposalId or a card with no preceding user text', () => {
    expect(requestTextForProposal([userMsg('hi'), assistantCard('call_p1')], 'call_nope')).toBeNull();
    expect(requestTextForProposal([assistantCard('call_p1')], 'call_p1')).toBeNull();
    expect(requestTextForProposal([userMsg('   '), assistantCard('call_p1')], 'call_p1')).toBeNull();
  });

  it('collapses whitespace runs and cuts to 400 chars with an ellipsis', () => {
    const spaced: AuthorMessage[] = [userMsg('a  \n\t b   c'), assistantCard('call_p1')];
    expect(requestTextForProposal(spaced, 'call_p1')).toBe('a b c');
    const long: AuthorMessage[] = [userMsg('x'.repeat(500)), assistantCard('call_p1')];
    const text = requestTextForProposal(long, 'call_p1');
    expect(text).toHaveLength(400);
    expect(text?.endsWith('…')).toBe(true);
  });
});
