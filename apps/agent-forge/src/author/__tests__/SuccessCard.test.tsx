import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import type { Requirement } from '../../../shared/authorWire';
import { SuccessCard, type SuccessCardProps } from '../SuccessCard';
import { ToastProvider } from '../../ui/Toast';
import { render } from '../../ui/__tests__/render';
import { initialAuthorChatState, type AuthorChatState } from '../authorChatReducer';
import type { AuthorChat } from '../AuthorChatContext';

const getRequirements = vi.hoisted(() => vi.fn());
vi.mock('../../runtime/runtimeClient', () => ({
  runtimeClient: { getAgentRequirements: getRequirements },
  RuntimeApiError: class RuntimeApiError extends Error {},
}));

/** A chat whose actions are spies; `enable` resolves the output the test sets. */
function chatWith(over: Partial<AuthorChat> = {}, state: Partial<AuthorChatState> = {}): AuthorChat {
  return {
    state: { ...initialAuthorChatState, connection: 'open', ...state },
    isStreaming: false,
    send: vi.fn(),
    stop: vi.fn(),
    newChat: vi.fn(),
    openSession: vi.fn(),
    setFocus: vi.fn(),
    apply: vi.fn(),
    enable: vi.fn(async () => ({ ok: true as const, agentId: 'a1', enabled: true, status: 'updated' as const, missingRequirements: 0 })),
    submitSecret: vi.fn(),
    dismissError: vi.fn(),
    ...over,
  };
}

function req(over: Partial<Requirement>): Requirement {
  return { id: 'secret:JIRA', kind: 'secret', status: 'missing', label: 'JIRA_TOKEN', ...over };
}

function props(over: Partial<SuccessCardProps> = {}): SuccessCardProps {
  return {
    kind: 'create',
    agentId: 'triage-bot',
    name: 'Triage bot',
    version: 1,
    enabledNow: false,
    chat: chatWith(),
    ...over,
  };
}

const mount = (p: SuccessCardProps) => render(<ToastProvider><SuccessCard {...p} /></ToastProvider>);

beforeEach(() => {
  getRequirements.mockReset();
  window.location.hash = '#/agents';
});

afterEach(() => {
  window.location.hash = '';
});

describe('SuccessCard', () => {
  it('create: title, the off-for-now hint, Enable agent and Open in canvas', () => {
    const c = mount(props());
    expect(c.querySelector('.success-card')?.getAttribute('role')).toBe('status');
    expect(c.querySelector('.success-card-title')?.textContent).toBe('Created “Triage bot”');
    expect(c.querySelector('.success-card-hint')?.textContent).toBe(
      "It's off for now. Review it, then turn it on here or ask in this chat."
    );
    expect(c.querySelector('.btn-primary')?.textContent).toBe('Enable agent');
    expect(c.querySelector('.btn-ghost')?.textContent).toBe('Open in canvas');
  });

  it('update: version hint and no Enable agent button', () => {
    const c = mount(props({ kind: 'update', version: 3 }));
    expect(c.querySelector('.success-card-title')?.textContent).toBe('Updated “Triage bot”');
    expect(c.querySelector('.success-card-hint')?.textContent).toBe('Saved as version 3.');
    expect(c.querySelector('.btn-primary')).toBeNull();
    expect(c.querySelector('.success-card-on')).toBeNull();
  });

  it('an already-on create shows “On” instead of the button', () => {
    const c = mount(props({ enabledNow: true }));
    expect(c.querySelector('.success-card-on')?.textContent).toBe('On');
    expect(c.querySelector('.btn-primary')).toBeNull();
  });

  it('missing requirement rows list their labels', () => {
    const c = mount(
      props({
        requirements: [
          req({ id: 'secret:JIRA', label: 'JIRA_TOKEN' }),
          req({ id: 'provider:anthropic', kind: 'provider_key', label: 'Anthropic API key' }),
          req({ id: 'mcp:gh', status: 'ok', label: 'github' }),
        ],
      })
    );
    const labels = [...c.querySelectorAll('.success-card-reqs li')].map((li) => li.textContent);
    expect(labels).toEqual(['JIRA_TOKEN', 'Anthropic API key']);
  });
});

describe('SuccessCard enable', () => {
  it('calls enable once, shows On and toasts on success', async () => {
    const chat = chatWith();
    const c = mount(props({ chat }));
    const button = c.querySelector<HTMLButtonElement>('.btn-primary')!;
    await act(async () => {
      button.click();
    });
    expect(chat.enable).toHaveBeenCalledTimes(1);
    expect(chat.enable).toHaveBeenCalledWith('triage-bot');
    expect(c.querySelector('.success-card-on')?.textContent).toBe('On');
    expect(c.querySelector('.btn-primary')).toBeNull();
    expect(document.querySelector('.toast-success .toast-message')?.textContent).toBe('“Triage bot” is on');
  });

  it('shows the warn line and fresh requirement list when requirements are missing', async () => {
    const chat = chatWith({
      enable: vi.fn(async () => ({
        ok: true as const,
        agentId: 'triage-bot',
        enabled: true,
        status: 'updated' as const,
        missingRequirements: 2,
      })),
    });
    getRequirements.mockResolvedValue([
      req({ label: 'JIRA_TOKEN' }),
      req({ id: 'mcp:gh', label: 'github MCP server' }),
      req({ id: 'ok:1', status: 'ok', label: 'fine' }),
    ]);
    const c = mount(props({ chat }));
    await act(async () => {
      c.querySelector<HTMLButtonElement>('.btn-primary')!.click();
    });
    expect(c.querySelector('.success-card-warn')?.textContent).toBe(
      'Turned on. 2 requirements are still missing, so runs may fail.'
    );
    expect(getRequirements).toHaveBeenCalledWith('triage-bot');
    const labels = [...c.querySelectorAll('.success-card-reqs li')].map((li) => li.textContent);
    expect(labels).toEqual(['JIRA_TOKEN', 'github MCP server']);
  });

  it('uses the singular in the warn line for one missing requirement', async () => {
    const chat = chatWith({
      enable: vi.fn(async () => ({
        ok: true as const,
        agentId: 'triage-bot',
        enabled: true,
        status: 'updated' as const,
        missingRequirements: 1,
      })),
    });
    getRequirements.mockResolvedValue([req({})]);
    const c = mount(props({ chat }));
    await act(async () => {
      c.querySelector<HTMLButtonElement>('.btn-primary')!.click();
    });
    expect(c.querySelector('.success-card-warn')?.textContent).toBe(
      'Turned on. 1 requirement is still missing, so runs may fail.'
    );
  });

  it('toasts the server message and re-enables the button on failure', async () => {
    const chat = chatWith({ enable: vi.fn(async () => Promise.reject(new Error('This chat did not create that agent.'))) });
    const c = mount(props({ chat }));
    await act(async () => {
      c.querySelector<HTMLButtonElement>('.btn-primary')!.click();
    });
    expect(document.querySelector('.toast-error .toast-message')?.textContent).toBe('This chat did not create that agent.');
    expect(c.querySelector<HTMLButtonElement>('.btn-primary')?.textContent).toBe('Enable agent');
    expect(c.querySelector('.success-card-on')).toBeNull();
  });
});

describe('SuccessCard Open in canvas', () => {
  it('navigates to the agent canvas route', () => {
    const c = mount(props());
    act(() => c.querySelector<HTMLButtonElement>('.btn-ghost')!.click());
    expect(window.location.hash).toBe('#/agents/triage-bot');
  });

  it('is hidden while that agent is already on screen', () => {
    window.location.hash = '#/agents/triage-bot';
    const c = mount(props());
    expect(c.querySelector('.btn-ghost')).toBeNull();
    expect(c.querySelector('.btn-primary')?.textContent).toBe('Enable agent');
  });

  it('still shows for a different agent on screen', () => {
    window.location.hash = '#/agents/other-agent';
    const c = mount(props());
    expect(c.querySelector('.btn-ghost')?.textContent).toBe('Open in canvas');
  });
});
