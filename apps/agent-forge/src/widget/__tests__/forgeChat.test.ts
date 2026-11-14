import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defineForgeChat, ForgeChatElement, FORGE_CHAT_TAG } from '../forgeChat';

const ENDPOINT = 'http://localhost:4750/serve/support-bot/chat';

function sse(frames: Array<{ event?: string; data: unknown }>): string {
  return frames
    .map((frame) => `${frame.event !== undefined ? `event: ${frame.event}\n` : ''}data: ${typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data)}\n\n`)
    .join('');
}

function okResponse(body: string | ReadableStream<Uint8Array>): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const REPLY = sse([
  { data: { type: 'text.delta', text: 'Hel' } },
  { data: { type: 'text.delta', text: 'lo!' } },
  { data: { type: 'tool.start', toolCallId: 't1', toolName: 'search', args: {} } },
  { data: { type: 'tool.done', toolCallId: 't1', toolName: 'search', result: null, durationMs: 3 } },
  { event: 'done', data: {} },
]);

interface Mounted {
  el: ForgeChatElement;
  log(): HTMLElement;
  input(): HTMLTextAreaElement;
  sendButton(): HTMLButtonElement;
}

function mount(attrs: Record<string, string> = {}): Mounted {
  const el = document.createElement(FORGE_CHAT_TAG) as ForgeChatElement;
  for (const [name, value] of Object.entries({ endpoint: ENDPOINT, ...attrs })) {
    el.setAttribute(name, value);
  }
  document.body.appendChild(el);
  const root = el.shadowRoot!;
  return {
    el,
    log: () => root.querySelector<HTMLElement>('.fc-log')!,
    input: () => root.querySelector<HTMLTextAreaElement>('#fc-input')!,
    sendButton: () => root.querySelector<HTMLButtonElement>('.fc-send')!,
  };
}

function rows(el: ForgeChatElement, cls: string): HTMLElement[] {
  return [...el.shadowRoot!.querySelectorAll<HTMLElement>(`.${cls}`)];
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  defineForgeChat();
  sessionStorage.clear();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('forgeChat element', () => {
  it('streams the reply: user message, agent text, tool rows, done', async () => {
    fetchMock.mockResolvedValue(okResponse(REPLY));
    const { el, input, sendButton } = mount();
    input().value = 'hi there';
    sendButton().click();
    await vi.waitFor(() => expect(rows(el, 'fc-msg-agent')).toHaveLength(1));
    await vi.waitFor(() => expect(rows(el, 'fc-tool')).toHaveLength(1));

    expect(rows(el, 'fc-msg-user')[0]!.textContent).toBe('hi there');
    expect(rows(el, 'fc-msg-agent')[0]!.textContent).toBe('Hello!');
    expect(rows(el, 'fc-tool')[0]!.textContent).toBe('Used search');
    expect(input().value).toBe('');
    expect(input().disabled).toBe(false);
    expect(sendButton().textContent).toBe('Send');
  });

  it('sends the bearer token only when the token attribute is set', async () => {
    fetchMock.mockResolvedValue(okResponse(REPLY));
    mount({ token: 'sekrit' }).el.send('yo');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sekrit');
    expect(JSON.parse(init.body as string)).toMatchObject({ input: 'yo' });
    expect(typeof JSON.parse(init.body as string).sessionId).toBe('string');

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(okResponse(REPLY));
    mount().el.send('yo');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const plain = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((plain.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('keeps the session id across a re-mount on the same tab', async () => {
    fetchMock.mockResolvedValue(okResponse(REPLY));
    const first = mount();
    await first.el.send('one');
    first.el.remove();
    const second = mount();
    await second.el.send('two');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string));
    expect(bodies[0]!.sessionId).toBe(bodies[1]!.sessionId);
    expect(bodies[1]!.input).toBe('two');
  });

  it('scopes the session id per endpoint', async () => {
    fetchMock.mockResolvedValue(okResponse(REPLY));
    await mount().el.send('a');
    const other = document.createElement(FORGE_CHAT_TAG) as ForgeChatElement;
    other.setAttribute('endpoint', 'http://localhost:4750/serve/other/chat');
    document.body.appendChild(other);
    await other.send('b');
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string));
    expect(bodies[0]!.sessionId).not.toBe(bodies[1]!.sessionId);
  });

  it('still works when sessionStorage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    fetchMock.mockResolvedValue(okResponse(REPLY));
    const { el } = mount();
    await el.send('still works');
    expect(rows(el, 'fc-msg-agent')[0]!.textContent).toBe('Hello!');
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(typeof body.sessionId).toBe('string');
    expect(body.sessionId.length).toBeGreaterThan(0);
  });

  it.each([
    [401, 'The chat token is missing or wrong.'],
    [404, 'This agent is not being served right now.'],
    [500, 'The agent could not answer (HTTP 500).'],
  ])('maps HTTP %i to its error copy', async (status, copy) => {
    fetchMock.mockResolvedValue(new Response('nope', { status }));
    const { el } = mount();
    await el.send('hi');
    expect(rows(el, 'fc-error')[0]!.textContent).toBe(copy);
  });

  it('maps a network failure to its error copy', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const { el } = mount();
    await el.send('hi');
    expect(rows(el, 'fc-error')[0]!.textContent).toBe('Could not reach the agent.');
  });

  it('maps an error frame to its error copy', async () => {
    fetchMock.mockResolvedValue(
      okResponse(sse([{ data: { type: 'error', error: { message: 'model exploded' } } }, { event: 'done', data: {} }])),
    );
    const { el } = mount();
    await el.send('hi');
    expect(rows(el, 'fc-error')[0]!.textContent).toBe('The agent could not answer: model exploded');
  });

  it('stops on approval.requested with the fixed copy', async () => {
    fetchMock.mockResolvedValue(
      okResponse(
        sse([
          { data: { type: 'approval.requested', toolCallId: 't1', toolName: 'deploy' } },
          { data: { type: 'text.delta', text: 'should not appear' } },
          { event: 'done', data: {} },
        ]),
      ),
    );
    const { el } = mount();
    await el.send('deploy it');
    expect(rows(el, 'fc-error')[0]!.textContent).toBe(
      'This agent needs an approval that this chat cannot give. Open Studio to decide it.',
    );
    expect(rows(el, 'fc-msg-agent')).toHaveLength(0);
  });

  it('Stop aborts the fetch and appends a Stopped row', async () => {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
        c.enqueue(new TextEncoder().encode(sse([{ data: { type: 'text.delta', text: 'partial' } }])));
      },
    });
    // A real fetch rejects the pending body read when its signal aborts;
    // emulate that by erroring the stream.
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      init.signal?.addEventListener('abort', () => ctrl.error(new DOMException('Aborted', 'AbortError')));
      return Promise.resolve(okResponse(stream));
    });
    const { el, input, sendButton } = mount();
    const pending = el.send('hi');
    await vi.waitFor(() => expect(rows(el, 'fc-msg-agent')).toHaveLength(1));
    expect(sendButton().textContent).toBe('Stop');
    sendButton().click();
    await pending;
    expect(rows(el, 'fc-tool').at(-1)!.textContent).toBe('Stopped');
    expect(input().disabled).toBe(false);
  });

  it('disconnecting aborts a running turn', async () => {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
      },
    });
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      init.signal?.addEventListener('abort', () => ctrl.error(new DOMException('Aborted', 'AbortError')));
      return Promise.resolve(okResponse(stream));
    });
    const { el } = mount();
    const pending = el.send('hi');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const signal = (fetchMock.mock.calls[0]![1] as RequestInit).signal!;
    el.remove();
    await pending;
    expect(signal.aborted).toBe(true);
    expect(rows(el, 'fc-tool').at(-1)!.textContent).toBe('Stopped');
  });

  it('reset starts a new session id and clears the log', async () => {
    fetchMock.mockResolvedValue(okResponse(REPLY));
    const { el } = mount();
    await el.send('one');
    const firstId = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string).sessionId;
    const resetBtn = el.shadowRoot!.querySelector<HTMLButtonElement>('.fc-reset')!;
    resetBtn.click();
    expect(rows(el, 'fc-msg-user')).toHaveLength(0);
    await el.send('two');
    const secondId = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string).sessionId;
    expect(secondId).not.toBe(firstId);
  });

  it('Enter sends and Shift+Enter does not', async () => {
    fetchMock.mockResolvedValue(okResponse(REPLY));
    const { el, input } = mount();
    input().value = 'hello';
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    expect(fetchMock).not.toHaveBeenCalled();
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(el.shadowRoot!.querySelector('.fc-msg-user')!.textContent).toBe('hello');
  });

  it('whitespace-only input does nothing', async () => {
    const { input, sendButton } = mount();
    input().value = '   ';
    sendButton().click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exposes the contracted accessibility hooks', () => {
    const { el } = mount({ title: 'Support' });
    const root = el.shadowRoot!;
    const log = root.querySelector('.fc-log')!;
    expect(log.getAttribute('role')).toBe('log');
    expect(log.getAttribute('aria-live')).toBe('polite');
    expect(root.querySelector('label.fc-label')!.getAttribute('for')).toBe('fc-input');
    expect(root.querySelector('.fc-reset')!.getAttribute('aria-label')).toBe('Start a new chat');
    expect(root.querySelector('.fc-title')!.textContent).toBe('Support');
  });

  it('updates title and placeholder attributes live', () => {
    const { el } = mount();
    el.setAttribute('title', 'Help');
    el.setAttribute('placeholder', 'Type here');
    expect(el.shadowRoot!.querySelector('.fc-title')!.textContent).toBe('Help');
    expect(el.shadowRoot!.querySelector('#fc-input')!.getAttribute('placeholder')).toBe('Type here');
  });
});
