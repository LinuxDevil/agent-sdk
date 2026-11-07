import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act } from 'react';
// Registers the requestSecret renderer for the AuthorMessages mounts.
import '../secretRenderers';
import type {
  AuthorAssistantMessage,
  AuthorMessage,
  AuthorToolPart,
  RequestSecretOutput,
} from '../../../shared/authorWire';
import { AuthorMessages } from '../AuthorMessages';
import { render } from '../../ui/__tests__/render';
import { installMemoryStorage } from '../../ui/__tests__/memoryStorage';
import {
  authorChatReducer,
  initialAuthorChatState,
  type AuthorChatState,
} from '../authorChatReducer';
import { RuntimeApiError } from '../../runtime/runtimeClient';
import type { AuthorChat } from '../AuthorChatContext';

vi.mock('../../runtime/runtimeClient', () => ({
  runtimeClient: {},
  RuntimeApiError: class RuntimeApiError extends Error {
    constructor(
      message: string,
      public readonly status: number,
      public readonly code?: string
    ) {
      super(message);
    }
  },
}));

/** A chat whose actions are spies; `submitSecret` resolves by default. */
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
    enable: vi.fn(),
    submitSecret: vi.fn(async () => {}),
    recheckSetup: vi.fn(),
    dismissError: vi.fn(),
    ...over,
  };
}

let seq = 0;
function secretPart(over: Partial<AuthorToolPart> = {}): AuthorToolPart {
  return {
    type: 'tool',
    toolCallId: `tc_s${++seq}`,
    name: 'requestSecret',
    input: { name: 'JIRA_TOKEN', why: 'The agent posts to Jira.' },
    state: 'pending',
    ...over,
  };
}

function assistant(parts: AuthorAssistantMessage['parts']): AuthorAssistantMessage {
  return { id: `m_a_${++seq}`, role: 'assistant', parts, at: '2026-01-01T00:00:00.000Z' };
}

function mount(messages: AuthorMessage[], chat: AuthorChat): HTMLDivElement {
  return render(<AuthorMessages messages={messages} active={null} chat={chat} />);
}

function typeInto(el: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const form = (c: HTMLElement) => c.querySelector<HTMLFormElement>('.secret-card')!;
const valueInput = (c: HTMLElement) => c.querySelector<HTMLInputElement>('.secret-card input[type="password"]')!;
const saveButton = (c: HTMLElement) =>
  [...c.querySelectorAll<HTMLButtonElement>('.secret-card button')].find((b) => b.type === 'submit')!;
const skipButton = (c: HTMLElement) =>
  [...c.querySelectorAll<HTMLButtonElement>('.secret-card button')].find((b) => b.textContent === 'Skip')!;

beforeEach(() => {
  installMemoryStorage();
  window.location.hash = '#/';
});

describe('requestSecret part rendering', () => {
  it('a busy part (pending, no output) keeps the quiet activity line', () => {
    const c = mount([assistant([secretPart()])], chatWith());
    expect(c.querySelector('.secret-card')).toBeNull();
    expect(c.querySelector('.author-activity')?.textContent).toBe('Preparing a secure card…');
  });

  it('a pending part with a pending output renders the secure form', () => {
    const part = secretPart({ output: { ok: true, name: 'JIRA_TOKEN', status: 'pending' } });
    const c = mount([assistant([part])], chatWith());
    const card = form(c);
    expect(card.getAttribute('aria-labelledby')).toBe(`secret-${part.toolCallId}-title`);
    expect(card.getAttribute('autocomplete')).toBe('off');
    expect(c.querySelector(`#secret-${part.toolCallId}-title`)?.textContent).toBe('Enter JIRA_TOKEN');
    expect(c.querySelector('.secret-card-why')?.textContent).toBe('The agent posts to Jira.');
    const input = valueInput(c);
    expect(input.id).toBe(`secret-${part.toolCallId}-value`);
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.getAttribute('spellcheck')).toBe('false');
    expect(c.querySelector('label.field-label')?.getAttribute('for')).toBe(input.id);
    expect(c.querySelector('.secret-card-note')?.textContent).toBe(
      "Stored encrypted in Studio's secrets store on this machine. The Author never sees the value."
    );
    expect(saveButton(c).textContent).toBe('Save secret');
    expect(skipButton(c).textContent).toBe('Skip');
  });

  it('saved, exists and declined parts render their one-line states', () => {
    const outputs: [RequestSecretOutput, string, string, boolean][] = [
      [{ ok: true, name: 'JIRA_TOKEN', status: 'saved' }, 'JIRA_TOKEN saved', 'secret-card-done', true],
      [{ ok: true, name: 'JIRA_TOKEN', status: 'exists' }, 'JIRA_TOKEN is already set', 'secret-card-done', true],
      [
        { ok: false, code: 'DECLINED', name: 'JIRA_TOKEN', error: 'x', userMessage: 'x' },
        'Skipped JIRA_TOKEN',
        'secret-card-done secret-card-done--skipped',
        false,
      ],
    ];
    for (const [output, text, cls, hasIcon] of outputs) {
      const c = mount(
        [assistant([secretPart({ state: 'done', output })])],
        chatWith()
      );
      const done = c.querySelector('.secret-card-done');
      expect(done?.className, text).toBe(cls);
      expect(done?.textContent).toBe(text);
      expect(done?.querySelector('svg') !== null, text).toBe(hasIcon);
      expect(c.querySelector('form.secret-card')).toBeNull();
    }
  });

  it('any other failure keeps the failed activity line', () => {
    const c = mount(
      [
        assistant([
          secretPart({ state: 'error', output: { ok: false, code: 'UNAVAILABLE', error: 'x', userMessage: 'x' } }),
        ]),
      ],
      chatWith()
    );
    expect(c.querySelector('.secret-card')).toBeNull();
    const line = c.querySelector('.author-activity');
    expect(line?.getAttribute('data-state')).toBe('failed');
    expect(line?.textContent).toBe("Couldn't ask for the secret");
  });
});

describe('SecretCard form', () => {
  function pending(): [AuthorToolPart, AuthorMessage[]] {
    const part = secretPart({ output: { ok: true, name: 'JIRA_TOKEN', status: 'pending' } });
    return [part, [assistant([part])]];
  }

  it('Save stays disabled with a reason while the value is empty or a reply streams', () => {
    const [, messages] = pending();
    let c = mount(messages, chatWith());
    expect(saveButton(c).disabled).toBe(true);
    expect(saveButton(c).getAttribute('title')).toBe('Enter a value first');

    c = mount(messages, chatWith({ isStreaming: true }));
    typeInto(valueInput(c), 's3cret');
    expect(saveButton(c).disabled).toBe(true);
    expect(saveButton(c).getAttribute('title')).toBe('Wait for the Author to finish replying');
  });

  it('Save posts the value through submitSecret and the input is empty right after submit', async () => {
    const [part, messages] = pending();
    let resolveSubmit: () => void = () => {};
    const chat = chatWith({
      submitSecret: vi.fn(() => new Promise<void>((resolve) => {
        resolveSubmit = resolve;
      })),
    });
    const c = mount(messages, chat);
    typeInto(valueInput(c), 's3cret-v4lue');
    await act(async () => {
      saveButton(c).click();
    });
    // Cleared before the submit resolves: the value lives in the POST body only.
    expect(valueInput(c).value).toBe('');
    expect(chat.submitSecret).toHaveBeenCalledTimes(1);
    expect(chat.submitSecret).toHaveBeenCalledWith(part.toolCallId, 'JIRA_TOKEN', 's3cret-v4lue');
    await act(async () => resolveSubmit());
  });

  it('Skip submits null for the same card', async () => {
    const [part, messages] = pending();
    const chat = chatWith();
    const c = mount(messages, chat);
    await act(async () => {
      skipButton(c).click();
    });
    expect(chat.submitSecret).toHaveBeenCalledWith(part.toolCallId, 'JIRA_TOKEN', null);
  });

  it('shows the route error, with a friendly line for NOT_PENDING', async () => {
    const [, messages] = pending();
    let c = mount(
      messages,
      chatWith({
        submitSecret: vi.fn(async () => {
          throw new RuntimeApiError('This request is no longer waiting for a value.', 404, 'NOT_PENDING');
        }),
      })
    );
    typeInto(valueInput(c), 'x');
    await act(async () => {
      saveButton(c).click();
    });
    expect(c.querySelector('.secret-card-error')?.textContent).toBe(
      'This card has expired. Ask the Author to request it again.'
    );

    c = mount(
      messages,
      chatWith({
        submitSecret: vi.fn(async () => {
          throw new RuntimeApiError('Wait for the Author to finish replying, then try again.', 409, 'BUSY');
        }),
      })
    );
    typeInto(valueInput(c), 'x');
    await act(async () => {
      saveButton(c).click();
    });
    expect(c.querySelector('.secret-card-error')?.textContent).toBe(
      'Wait for the Author to finish replying, then try again.'
    );
  });
});

describe('SecretCard secret hygiene', () => {
  it('the value never reaches localStorage', async () => {
    const storage = installMemoryStorage();
    const spy = vi.spyOn(storage, 'setItem');
    const [part, messages] = pendingFixture();
    const chat = chatWith();
    const c = mount(messages, chat);
    typeInto(valueInput(c), 's3cret-v4lue');
    await act(async () => {
      saveButton(c).click();
    });
    expect(chat.submitSecret).toHaveBeenCalledWith(part.toolCallId, 'JIRA_TOKEN', 's3cret-v4lue');
    for (const call of spy.mock.calls) {
      expect(call[1]).not.toContain('s3cret-v4lue');
    }
  });

  it('the value never enters the reducer state after secret.answered', () => {
    const part = secretPart({ output: { ok: true, name: 'JIRA_TOKEN', status: 'pending' } });
    const state: AuthorChatState = { ...initialAuthorChatState, messages: [assistant([part])] };
    const next = authorChatReducer(state, { type: 'secret.answered', toolCallId: part.toolCallId, outcome: 'saved' });
    expect(JSON.stringify(next)).not.toContain('s3cret-v4lue');
    const settled = (next.messages[0] as AuthorAssistantMessage).parts[0] as AuthorToolPart;
    expect(settled.state).toBe('done');
    expect(settled.output).toEqual({ ok: true, name: 'JIRA_TOKEN', status: 'saved' });
  });
});

function pendingFixture(): [AuthorToolPart, AuthorMessage[]] {
  const part = secretPart({ output: { ok: true, name: 'JIRA_TOKEN', status: 'pending' } });
  return [part, [assistant([part])]];
}
