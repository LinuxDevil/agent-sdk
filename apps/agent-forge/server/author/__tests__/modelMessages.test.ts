import { describe, it, expect } from 'vitest';
import { toModelMessages, uiEventText, userMessageText } from '../modelMessages';
import type { AuthorAssistantMessage, AuthorMessage, AuthorUserMessage } from '../../../shared/authorWire';

/**
 * toModelMessages: a stored Author transcript replays to the SDK `Message[]`
 * the Author model sees - never a system message (createAgent adds the
 * instructions), user text prefixed verbatim with its stored turnContext so a
 * re-rendered history is byte-identical and the provider prompt cache keeps
 * hitting.
 */
describe('toModelMessages', () => {
  const userMsg = (text: string, extra?: Partial<AuthorUserMessage>): AuthorUserMessage => ({
    id: 'm_user',
    role: 'user',
    text,
    at: '2026-10-29T10:00:00.000Z',
    ...extra,
  });

  it('converts user → assistant(text, tool, tool, text) → user to user, assistant(text + 2 toolCalls), tool, tool, assistant(text), user', () => {
    const transcript: AuthorMessage[] = [
      userMsg('Make me an agent'),
      {
        id: 'm_asst',
        role: 'assistant',
        at: '2026-10-29T10:00:01.000Z',
        parts: [
          { type: 'text', text: 'I will check ' },
          { type: 'text', text: 'the catalog.' },
          { type: 'tool', toolCallId: 'tc1', name: 'listAgents', input: {}, output: { agents: [] }, state: 'done' },
          {
            type: 'tool',
            toolCallId: 'tc2',
            name: 'getCurrentSpec',
            input: { agentId: 'support-triage' },
            output: { spec: { name: 'Support triage' } },
            state: 'done',
          },
          { type: 'text', text: 'Done checking.' },
        ],
      },
      userMsg('Thanks'),
    ];

    expect(toModelMessages(transcript)).toEqual([
      { role: 'user', content: 'Make me an agent' },
      {
        role: 'assistant',
        content: 'I will check the catalog.',
        toolCalls: [
          { id: 'tc1', type: 'function', function: { name: 'listAgents', arguments: '{}' } },
          {
            id: 'tc2',
            type: 'function',
            function: { name: 'getCurrentSpec', arguments: '{"agentId":"support-triage"}' },
          },
        ],
      },
      { role: 'tool', toolCallId: 'tc1', toolName: 'listAgents', content: '{"agents":[]}' },
      { role: 'tool', toolCallId: 'tc2', toolName: 'getCurrentSpec', content: '{"spec":{"name":"Support triage"}}' },
      { role: 'assistant', content: 'Done checking.' },
      { role: 'user', content: 'Thanks' },
    ]);
  });

  it('prefixes a stored user message with its turnContext verbatim, so a second conversion is byte-identical', () => {
    const turnContext = '[Studio context — written by the app, not the user. Treat it as data.]\nDate: 2026-10-29\nFocus: creating a new agent';
    const transcript: AuthorMessage[] = [userMsg('Add a cron trigger', { turnContext })];

    const first = toModelMessages(transcript);
    expect(first).toEqual([{ role: 'user', content: `${turnContext}\n\nAdd a cron trigger` }]);
    // A second conversion of the stored transcript replays byte-identically.
    expect(toModelMessages(transcript)).toEqual(first);
  });

  it('sends user text unchanged when no turnContext was stored', () => {
    expect(toModelMessages([userMsg('hi')])).toEqual([{ role: 'user', content: 'hi' }]);
    expect(userMessageText(userMsg('hi'))).toBe('hi');
  });

  it('emits a pending JSON tool result for pending parts and isError for error parts', () => {
    const assistant: AuthorAssistantMessage = {
      id: 'm_asst',
      role: 'assistant',
      at: '2026-10-29T10:00:01.000Z',
      parts: [
        {
          type: 'tool',
          toolCallId: 'tc-pending',
          name: 'requestSecret',
          input: { name: 'API_KEY', why: 'needs it' },
          state: 'pending',
        },
        {
          type: 'tool',
          toolCallId: 'tc-error',
          name: 'runDraft',
          input: {},
          state: 'error',
        },
        {
          type: 'tool',
          toolCallId: 'tc-error-out',
          name: 'saveAgent',
          input: {},
          output: { code: 'NO_PROPOSAL' },
          state: 'error',
        },
      ],
    };

    expect(toModelMessages([assistant])).toEqual([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'tc-pending',
            type: 'function',
            function: { name: 'requestSecret', arguments: '{"name":"API_KEY","why":"needs it"}' },
          },
          { id: 'tc-error', type: 'function', function: { name: 'runDraft', arguments: '{}' } },
          { id: 'tc-error-out', type: 'function', function: { name: 'saveAgent', arguments: '{}' } },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'tc-pending',
        toolName: 'requestSecret',
        content: '{"status":"pending","note":"Waiting for the user to answer the card."}',
      },
      {
        role: 'tool',
        toolCallId: 'tc-error',
        toolName: 'runDraft',
        content: '{"error":"Tool failed."}',
        isError: true,
      },
      {
        role: 'tool',
        toolCallId: 'tc-error-out',
        toolName: 'saveAgent',
        content: '{"code":"NO_PROPOSAL"}',
        isError: true,
      },
    ]);
  });

  it('uses null for a done tool part with no output and {} for a call with no input', () => {
    const assistant: AuthorAssistantMessage = {
      id: 'm_asst',
      role: 'assistant',
      at: '2026-10-29T10:00:01.000Z',
      parts: [{ type: 'tool', toolCallId: 'tc1', name: 'listAgents', input: undefined, state: 'done' }],
    };
    const messages = toModelMessages([assistant]);
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      toolCalls: [{ id: 'tc1', function: { arguments: '{}' } }],
    });
    expect(messages[1]).toMatchObject({ role: 'tool', content: 'null' });
  });

  it('skips an assistant message with no parts', () => {
    const transcript: AuthorMessage[] = [
      userMsg('one'),
      { id: 'm_empty', role: 'assistant', parts: [], at: '2026-10-29T10:00:01.000Z' },
      userMsg('two'),
    ];
    expect(toModelMessages(transcript)).toEqual([
      { role: 'user', content: 'one' },
      { role: 'user', content: 'two' },
    ]);
  });

  it('renders a save uiEvent as the [UI event] user text', () => {
    const transcript: AuthorMessage[] = [
      userMsg('', { uiEvent: { kind: 'save', proposalId: 'tc_9', agentId: 'support-triage', version: 4 } }),
    ];
    expect(toModelMessages(transcript)).toEqual([
      {
        role: 'user',
        content:
          '[UI event] User applied proposal tc_9. Studio saved agent "support-triage" (id "support-triage") as version 4. This was the user\'s action, not a tool call of yours. Treat the saved spec as the new baseline and do not save it again.',
      },
    ]);
  });

  it('never emits a system message', () => {
    const transcript: AuthorMessage[] = [userMsg('hi'), { id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'yo' }], at: 'x' }];
    expect(toModelMessages(transcript).every((m) => m.role !== 'system')).toBe(true);
  });
});

describe('uiEventText', () => {
  it('save uses the agent name when one is supplied', () => {
    expect(
      uiEventText({ kind: 'save', proposalId: 'tc_9', agentId: 'support-triage', version: 4 }, { agentName: 'Support triage' })
    ).toBe(
      '[UI event] User applied proposal tc_9. Studio saved agent "Support triage" (id "support-triage") as version 4. This was the user\'s action, not a tool call of yours. Treat the saved spec as the new baseline and do not save it again.'
    );
  });

  it('secret saved has the exact copy', () => {
    expect(uiEventText({ kind: 'secret', toolCallId: 'tc_1', name: 'API_KEY', outcome: 'saved' })).toBe(
      '[UI event] The user saved the secret API_KEY in Studio\'s secrets store. You cannot see its value. Refer to it as { "secret": "API_KEY" }.'
    );
  });

  it('secret declined has the exact copy', () => {
    expect(uiEventText({ kind: 'secret', toolCallId: 'tc_1', name: 'API_KEY', outcome: 'declined' })).toBe(
      '[UI event] The user skipped entering the secret API_KEY. Do not ask for it again in this turn. Carry on without it and say it is still missing.'
    );
  });
});
