import { describe, expect, it } from 'vitest';
import type { AgentSpecV2 } from 'lousho';
import type { AuthorMessage, Requirement, SpecChange } from '../../../../shared/authorWire';
import type { AuthorTurn } from '../../turnRunner';
import type { ReviewInput } from '../../proposal/review';
import {
  buildReviewState,
  conversationForReview,
  REVIEW_CONVERSATION_MAX_CHARS,
  REVIEW_INSTRUCTIONS_MAX_CHARS,
  type ReviewFacts,
} from '../state';

/**
 * The review-state builders (AA12): what the judge actually sees. The
 * conversation keeps user and assistant TEXT only (no tool parts, no
 * turn-context blocks, no `[UI event]` messages) and drops the oldest
 * text when it exceeds the budget; the draft's instructions and each
 * change's before/after strings are clamped so a huge spec cannot blow
 * the review prompt up.
 */

const SPEC: AgentSpecV2 = {
  version: 2,
  name: 'Mail triage',
  model: 'mock/mock-1',
  instructions: 'You triage mail.',
};

const FACTS: ReviewFacts = {
  builtinTools: new Set(['web_fetch', 'http_request']),
  guardrails: new Set(['pii']),
  triggerTypes: new Set(['chat', 'cron']),
};

const REQUIREMENTS: Requirement[] = [
  { id: 'provider:mock', kind: 'provider_key', status: 'ok', label: 'Mock provider' },
];

function turn(over: Partial<AuthorTurn> = {}): AuthorTurn {
  return {
    sessionId: 'sess-1',
    requestId: 'req-t',
    focus: { mode: 'create' },
    storedTranscript: [],
    userMessage: { id: 'm-1', role: 'user', text: 'Make me an agent that reads my mail.', at: '2026-01-01T00:00:00.000Z' },
    signal: new AbortController().signal,
    stepsRemaining: () => 12,
    state: new Map(),
    ...over,
  };
}

function input(over: Partial<ReviewInput> = {}, turnOver: Partial<AuthorTurn> = {}): ReviewInput {
  return {
    turn: turn(turnOver),
    identity: { kind: 'create' },
    toolName: 'proposeAgent',
    spec: SPEC,
    changes: [],
    requirements: REQUIREMENTS,
    ...over,
  };
}

describe('conversationForReview', () => {
  it('renders user and assistant text as "User: …" / "Assistant: …" joined by blank lines', () => {
    const messages: AuthorMessage[] = [
      { id: 'm-1', role: 'user', text: 'Build a mail triage agent.', at: '2026-01-01T00:00:00.000Z' },
      {
        id: 'm-2',
        role: 'assistant',
        parts: [{ type: 'text', text: 'What should it do with spam?' }],
        at: '2026-01-01T00:00:01.000Z',
      },
      { id: 'm-3', role: 'user', text: 'Archive it.', at: '2026-01-01T00:00:02.000Z' },
    ];
    expect(conversationForReview(messages, REVIEW_CONVERSATION_MAX_CHARS)).toBe(
      'User: Build a mail triage agent.\n\nAssistant: What should it do with spam?\n\nUser: Archive it.'
    );
  });

  it('excludes tool parts, turn-context blocks and [UI event] messages', () => {
    const messages: AuthorMessage[] = [
      {
        id: 'm-1',
        role: 'user',
        text: 'Change the model.',
        at: '2026-01-01T00:00:00.000Z',
        turnContext: 'TURN CONTEXT: editing agent x',
      },
      {
        id: 'm-2',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'One moment.' },
          { type: 'tool', toolCallId: 'call_1', name: 'proposeAgent', input: { draft: {} }, state: 'pending' },
          { type: 'text', text: 'Done.' },
        ],
        at: '2026-01-01T00:00:01.000Z',
      },
      {
        id: 'm-3',
        role: 'user',
        text: '',
        at: '2026-01-01T00:00:02.000Z',
        uiEvent: { kind: 'save', proposalId: 'call_1', agentId: 'a-1', version: 3 },
      },
      { id: 'm-4', role: 'user', text: 'Thanks.', at: '2026-01-01T00:00:03.000Z' },
    ];
    const conversation = conversationForReview(messages, REVIEW_CONVERSATION_MAX_CHARS);
    expect(conversation).toBe('User: Change the model.\n\nAssistant: One moment.Done.\n\nUser: Thanks.');
    expect(conversation).not.toContain('TURN CONTEXT');
    expect(conversation).not.toContain('proposeAgent');
    expect(conversation).not.toContain('UI event');
  });

  it('keeps the newest text when over budget, prefixed with …', () => {
    const messages: AuthorMessage[] = Array.from({ length: 20 }, (_, i) => ({
      id: `m-${i}`,
      role: 'user' as const,
      text: `message-${`${i}`.padStart(2, '0')}-${'x'.repeat(40)}`,
      at: '2026-01-01T00:00:00.000Z',
    }));
    const maxChars = 200;
    const conversation = conversationForReview(messages, maxChars);
    expect(conversation.length).toBeLessThanOrEqual(maxChars);
    expect(conversation.startsWith('…')).toBe(true);
    expect(conversation).toContain('message-19');
    expect(conversation).not.toContain('message-00');
  });
});

describe('buildReviewState', () => {
  it('marks a create as "A new agent the user asked for" and carries no changes', () => {
    const state = buildReviewState(input(), FACTS);
    expect(state.draft.kind).toBe('A new agent the user asked for');
    expect(state.draft.changes).toBeUndefined();
    expect(state.draft.spec.name).toBe('Mail triage');
  });

  it('marks an update as a change and carries clamped changes', () => {
    const changes: SpecChange[] = [
      {
        field: 'model',
        label: 'Model',
        section: 'Model',
        op: 'edit',
        before: 'mock/mock-1',
        after: 'mock/mock-2',
      },
      {
        field: 'instructions',
        label: 'Instructions',
        section: 'Instructions',
        op: 'edit',
        before: 'b'.repeat(900),
        after: 'a'.repeat(900),
        lines: [{ kind: 'add', text: 'new line' }],
      },
      {
        field: 'limits',
        label: 'Limits',
        section: 'Model',
        op: 'edit',
        before: { maxTokens: 100 },
        after: { maxTokens: 200 },
      },
    ];
    const state = buildReviewState(input({ identity: { kind: 'update', agentId: 'a-1' }, toolName: 'proposeAgentUpdate', changes }), FACTS);
    expect(state.draft.kind).toBe('A change to an existing agent; spec is the agent after the change');
    const shown = state.draft.changes!;
    expect(shown).toHaveLength(3);
    // Long strings clamp to 500 chars + '…'.
    expect(shown[1].before).toBe(`${'b'.repeat(500)}…`);
    expect(shown[1].after).toBe(`${'a'.repeat(500)}…`);
    // The line diff is dropped; non-string before/after pass through.
    expect('lines' in shown[1]).toBe(false);
    expect(shown[2].before).toEqual({ maxTokens: 100 });
    expect(shown[0].before).toBe('mock/mock-1');
  });

  it('clamps string instructions to the budget + an ellipsis, and leaves file refs alone', () => {
    const long = 'x'.repeat(REVIEW_INSTRUCTIONS_MAX_CHARS + 500);
    const clamped = buildReviewState(input({ spec: { ...SPEC, instructions: long } }), FACTS);
    const shown = clamped.draft.spec.instructions;
    expect(typeof shown).toBe('string');
    expect((shown as string).length).toBe(REVIEW_INSTRUCTIONS_MAX_CHARS + 1);
    expect((shown as string).endsWith('…')).toBe(true);
    const fileRef = buildReviewState(input({ spec: { ...SPEC, instructions: { file: 'prompt.md' } } }), FACTS);
    expect(fileRef.draft.spec.instructions).toEqual({ file: 'prompt.md' });
  });

  it('reports the requirements and the catalog name lists as facts', () => {
    const state = buildReviewState(input(), FACTS);
    expect(state.facts.requirements).toBe(REQUIREMENTS);
    expect(state.facts.builtinTools).toEqual(['web_fetch', 'http_request']);
    expect(state.facts.guardrails).toEqual(['pii']);
    expect(state.facts.triggerTypes).toEqual(['chat', 'cron']);
  });

  it('renders the stored transcript plus the current user message as the conversation', () => {
    const t = turn({
      storedTranscript: [
        { id: 'm-0', role: 'user', text: 'First ask.', at: '2026-01-01T00:00:00.000Z' },
      ],
    });
    const state = buildReviewState(input({ turn: t }), FACTS);
    expect(state.conversation).toBe('User: First ask.\n\nUser: Make me an agent that reads my mail.');
  });
});
