import { describe, it, expect, beforeEach, vi } from 'vitest';
// Registers the saveAgent/saveAgentUpdate renderers and the save uiEvent renderer.
import '../successRenderers';
import type {
  AuthorAssistantMessage,
  AuthorMessage,
  AuthorToolPart,
  AuthorUserMessage,
  ProposalOutput,
} from '../../../shared/authorWire';
import { AuthorMessages } from '../AuthorMessages';
import { ToastProvider } from '../../ui/Toast';
import { render } from '../../ui/__tests__/render';
import { initialAuthorChatState, type AuthorChatState } from '../authorChatReducer';
import type { AuthorChat } from '../AuthorChatContext';

const getRequirements = vi.hoisted(() => vi.fn());
vi.mock('../../runtime/runtimeClient', () => ({
  runtimeClient: { getAgentRequirements: getRequirements },
  RuntimeApiError: class RuntimeApiError extends Error {},
}));

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

function chatWith(state: Partial<AuthorChatState> = {}): AuthorChat {
  return {
    state: { ...initialAuthorChatState, connection: 'open', ...state },
    isStreaming: false,
    send: vi.fn(),
    stop: vi.fn(),
    newChat: vi.fn(),
    openSession: vi.fn(),
    setFocus: vi.fn(),
    apply: vi.fn(),
    enable: vi.fn(),
    submitSecret: vi.fn(),
    dismissError: vi.fn(),
  };
}

const mount = (messages: AuthorMessage[], active: AuthorAssistantMessage | null = null) =>
  render(
    <ToastProvider>
      <AuthorMessages messages={messages} active={active === null ? null : { requestId: 'r1', lastSeq: 0, assistant: active }} chat={chatWith({ messages })} />
    </ToastProvider>
  );

beforeEach(() => {
  getRequirements.mockReset();
  window.location.hash = '#/agents';
});

describe('save part renderers', () => {
  it('an ok saveAgent part draws the create SuccessCard', () => {
    const c = mount([
      assistant([tool({ toolCallId: 'tc_prop', name: 'proposeAgent', output: proposal() })]),
      assistant([
        tool({
          name: 'saveAgent',
          input: { proposalId: 'tc_prop' },
          output: { ok: true, agentId: 'triage-bot', name: 'Triage bot', version: 1, enabled: false },
        }),
      ]),
    ]);
    expect(c.querySelector('.success-card-title')?.textContent).toBe('Created “Triage bot”');
    expect(c.querySelector('.btn-primary')?.textContent).toBe('Enable agent');
  });

  it('an ok saveAgentUpdate part draws the update SuccessCard', () => {
    const c = mount([
      assistant([tool({ toolCallId: 'tc_prop', name: 'proposeAgentUpdate', output: proposal({ kind: 'update', agentId: 'a1' }) })]),
      assistant([
        tool({
          name: 'saveAgentUpdate',
          input: { agentId: 'a1', proposalId: 'tc_prop' },
          output: { ok: true, agentId: 'a1', name: 'Triage bot', version: 4, enabled: true },
        }),
      ]),
    ]);
    expect(c.querySelector('.success-card-title')?.textContent).toBe('Updated “Triage bot”');
    expect(c.querySelector('.success-card-hint')?.textContent).toBe('Saved as version 4.');
  });

  it('a failed or busy save part keeps the quiet activity line', () => {
    const c = mount([
      assistant([
        tool({ name: 'saveAgent', input: { proposalId: 'tc_prop' }, output: { ok: false, userMessage: 'Nope.' } }),
        tool({ name: 'saveAgent', input: { proposalId: 'tc_prop' }, state: 'pending' }),
      ]),
    ]);
    expect(c.querySelector('.success-card')).toBeNull();
    expect(c.querySelectorAll('.author-activity').length).toBe(2);
  });

  it('a later ok setAgentEnabled part switches the card to On', () => {
    const c = mount([
      assistant([
        tool({ toolCallId: 'tc_prop', name: 'proposeAgent', output: proposal() }),
        tool({
          name: 'saveAgent',
          input: { proposalId: 'tc_prop' },
          output: { ok: true, agentId: 'triage-bot', name: 'Triage bot', version: 1, enabled: false },
        }),
        tool({
          name: 'setAgentEnabled',
          input: { agentId: 'triage-bot' },
          output: { ok: true, agentId: 'triage-bot', enabled: true, status: 'updated', missingRequirements: 0 },
        }),
      ]),
    ]);
    expect(c.querySelector('.success-card-on')?.textContent).toBe('On');
    expect(c.querySelector('.btn-primary')).toBeNull();
  });
});

describe('save uiEvent renderer', () => {
  it('draws the SuccessCard the button save produced, resolved from the propose part', () => {
    const c = mount([
      assistant([tool({ toolCallId: 'tc_prop', name: 'proposeAgent', output: proposal() })]),
      user('', { kind: 'save', proposalId: 'tc_prop', agentId: 'triage-bot', version: 1 }),
    ]);
    expect(c.querySelector('.success-card-title')?.textContent).toBe('Created “Triage bot”');
    expect(c.querySelector('.author-event')).toBeNull();
  });

  it('falls back to update + the agent id when no card matches', () => {
    const c = mount([user('', { kind: 'save', proposalId: 'tc_gone', agentId: 'triage-bot', version: 3 })]);
    expect(c.querySelector('.success-card-title')?.textContent).toBe('Updated “triage-bot”');
    expect(c.querySelector('.success-card-hint')?.textContent).toBe('Saved as version 3.');
  });

  it('a secret uiEvent still draws its quiet event line', () => {
    const c = mount([user('', { kind: 'secret', toolCallId: 'tc_s', name: 'JIRA_TOKEN', outcome: 'saved' })]);
    expect(c.querySelector('.success-card')).toBeNull();
    expect(c.querySelector('.author-event')?.textContent).toBe('You saved JIRA_TOKEN');
  });

  it('a plain user message still draws its bubble', () => {
    const c = mount([user('Build me a bot')]);
    expect(c.querySelector('.author-bubble')?.textContent).toBe('Build me a bot');
    expect(c.querySelector('.success-card')).toBeNull();
  });
});
