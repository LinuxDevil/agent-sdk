/**
 * `<forge-chat>` (X04a): a dependency-free custom element that chats with
 * a served agent. It POSTs each message to the SDK `/chat` endpoint
 * (`{ sessionId, input }` → SSE `data: <AgentEvent>` frames, then
 * `event: done`), streams the reply, renders tool calls as one-line rows
 * and shows errors inline. The session id lives in `sessionStorage` per
 * page tab. X04b bundles this into the embeddable script; nothing here
 * imports the app or `@lousho/*`.
 */
import { FORGE_CHAT_STYLES } from './forgeChatStyles';
import { createSseParser, type SseFrame } from './sseFrames';

export const FORGE_CHAT_TAG = 'forge-chat';

const SESSION_PREFIX = 'forge-chat:';
const SCROLL_THRESHOLD_PX = 40;

interface AgentEventLike {
  type?: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  error?: { message?: string } | string;
}

/** The DOM refs and per-turn state `applyFrame` works against. */
interface TurnRefs {
  log: HTMLElement;
  agentEl: HTMLElement | null;
  toolRows: Map<string, HTMLElement>;
  userScrolledUp: () => boolean;
  scrollToBottom: () => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function appendRow(refs: TurnRefs, className: string, text: string): HTMLElement {
  const row = el(document, 'div', className, text);
  refs.log.appendChild(row);
  refs.scrollToBottom();
  return row;
}

function agentMessage(refs: TurnRefs): HTMLElement {
  if (refs.agentEl === null) {
    refs.agentEl = el(document, 'div', 'fc-msg fc-msg-agent');
    refs.log.appendChild(refs.agentEl);
    refs.scrollToBottom();
  }
  return refs.agentEl;
}

function errorText(refs: TurnRefs, prefix: string, detail?: string): void {
  const row = el(document, 'div', 'fc-error');
  row.setAttribute('role', 'alert');
  row.textContent = detail === undefined ? prefix : `${prefix}${detail}`;
  refs.log.appendChild(row);
  refs.scrollToBottom();
}

function toolNameOf(event: AgentEventLike): string {
  return event.toolName ?? 'tool';
}

function applyTextDelta(refs: TurnRefs, event: AgentEventLike): boolean {
  if (typeof event.text === 'string') agentMessage(refs).textContent += event.text;
  refs.scrollToBottom();
  return false;
}

function applyToolStart(refs: TurnRefs, event: AgentEventLike): boolean {
  if (event.toolCallId === undefined) return false;
  const row = appendRow(refs, 'fc-tool', `Using ${toolNameOf(event)}…`);
  refs.toolRows.set(event.toolCallId, row);
  return false;
}

function applyToolEnd(refs: TurnRefs, event: AgentEventLike): boolean {
  if (event.toolCallId === undefined) return false;
  const row = refs.toolRows.get(event.toolCallId);
  refs.toolRows.delete(event.toolCallId);
  if (row !== undefined) {
    row.textContent = event.type === 'tool.done' ? `Used ${toolNameOf(event)}` : `${toolNameOf(event)} failed`;
  }
  return false;
}

function applyErrorFrame(refs: TurnRefs, event: AgentEventLike): boolean {
  const message = typeof event.error === 'object' ? event.error?.message : event.error;
  errorText(refs, 'The agent could not answer: ', message ?? 'unknown error');
  return false;
}

function applyRunDone(refs: TurnRefs, event: AgentEventLike): boolean {
  if (refs.agentEl !== null && refs.agentEl.textContent === '' && typeof event.text === 'string') {
    refs.agentEl.textContent = event.text;
  }
  return false;
}

/** `true` when the frame ends the turn early (an approval the widget cannot give). */
function applyFrame(refs: TurnRefs, event: AgentEventLike): boolean {
  switch (event.type) {
    case 'text.delta':
      return applyTextDelta(refs, event);
    case 'tool.start':
    case 'tool.resume':
      return applyToolStart(refs, event);
    case 'tool.done':
    case 'tool.error':
      return applyToolEnd(refs, event);
    case 'error':
      return applyErrorFrame(refs, event);
    case 'approval.requested':
      errorText(refs, 'This agent needs an approval that this chat cannot give. Open Studio to decide it.');
      return true;
    case 'run.done':
      return applyRunDone(refs, event);
    default:
      return false;
  }
}

function newSessionId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `s-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

const TEMPLATE = `
<div class="fc" part="root">
  <header class="fc-head"><span class="fc-title"></span><button class="fc-reset" type="button" aria-label="Start a new chat">↺</button></header>
  <div class="fc-log" role="log" aria-live="polite" aria-relevant="additions"></div>
  <form class="fc-form">
    <label class="fc-label" for="fc-input">Message</label>
    <textarea id="fc-input" class="fc-input" rows="2"></textarea>
    <button class="fc-send" type="submit">Send</button>
  </form>
</div>`;

export class ForgeChatElement extends HTMLElement {
  static observedAttributes = ['endpoint', 'token', 'title', 'placeholder'];

  private root: ShadowRoot | null = null;
  private refs: TurnRefs | null = null;
  private titleEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private sendEl: HTMLButtonElement | null = null;
  private turn: AbortController | null = null;
  private sessionIdValue: string | undefined;
  private rendered = false;

  connectedCallback(): void {
    this.render();
  }

  disconnectedCallback(): void {
    this.turn?.abort();
    this.turn = null;
  }

  attributeChangedCallback(name: string): void {
    if (!this.rendered) return;
    if (name === 'title') this.titleEl!.textContent = this.titleText();
    if (name === 'placeholder') this.inputEl!.placeholder = this.placeholderText();
  }

  /** Posts `text` as a chat turn and streams the reply into the log. */
  async send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === '' || this.turn !== null || this.refs === null) return;
    this.appendUserMessage(trimmed);
    this.inputEl!.value = '';
    this.setStreaming(true);

    const controller = new AbortController();
    this.turn = controller;
    try {
      await this.streamTurn(trimmed, controller.signal);
    } catch {
      if (controller.signal.aborted) appendRow(this.refs!, 'fc-tool', 'Stopped');
      else errorText(this.refs!, 'Could not reach the agent.');
    } finally {
      this.endTurn();
    }
  }

  /** Starts a new session: new session id, empty log. */
  reset(): void {
    this.turn?.abort();
    this.turn = null;
    this.sessionIdValue = this.rotateSessionId();
    if (this.refs !== null) {
      this.refs.agentEl = null;
      this.refs.toolRows.clear();
      this.refs.log.replaceChildren();
    }
    this.setStreaming(false);
  }

  private render(): void {
    if (this.rendered) return;
    this.rendered = true;
    this.root = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = FORGE_CHAT_STYLES;
    this.root.appendChild(style);
    const template = document.createElement('template');
    template.innerHTML = TEMPLATE;
    this.root.appendChild(template.content.cloneNode(true));

    const log = this.root.querySelector<HTMLElement>('.fc-log')!;
    this.titleEl = this.root.querySelector<HTMLElement>('.fc-title')!;
    this.inputEl = this.root.querySelector<HTMLTextAreaElement>('#fc-input')!;
    this.sendEl = this.root.querySelector<HTMLButtonElement>('.fc-send')!;
    const form = this.root.querySelector<HTMLFormElement>('.fc-form')!;
    const resetBtn = this.root.querySelector<HTMLButtonElement>('.fc-reset')!;

    this.titleEl.textContent = this.titleText();
    this.inputEl.placeholder = this.placeholderText();

    let userScrolledUp = false;
    log.addEventListener('scroll', () => {
      userScrolledUp = log.scrollHeight - log.scrollTop - log.clientHeight > SCROLL_THRESHOLD_PX;
    });
    this.refs = {
      log,
      agentEl: null,
      toolRows: new Map(),
      userScrolledUp: () => userScrolledUp,
      scrollToBottom: () => {
        if (!userScrolledUp) log.scrollTop = log.scrollHeight;
      },
    };

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.send(this.inputEl!.value);
    });
    this.inputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    resetBtn.addEventListener('click', () => this.reset());
    this.sendEl.addEventListener('click', () => {
      if (this.turn !== null) this.turn.abort();
    });
  }

  private titleText(): string {
    return this.getAttribute('title') ?? 'Chat';
  }

  private placeholderText(): string {
    return this.getAttribute('placeholder') ?? 'Ask something…';
  }

  private appendUserMessage(text: string): void {
    appendRow(this.refs!, 'fc-msg fc-msg-user', text);
    this.refs!.agentEl = null;
  }

  private sessionId(): string {
    if (this.sessionIdValue !== undefined) return this.sessionIdValue;
    const key = `${SESSION_PREFIX}${this.getAttribute('endpoint') ?? ''}`;
    try {
      const stored = sessionStorage.getItem(key);
      if (stored !== null) return (this.sessionIdValue = stored);
      return (this.sessionIdValue = this.writeSessionId(key));
    } catch {
      return (this.sessionIdValue = newSessionId());
    }
  }

  /** A fresh id persisted under the session key; falls back to memory-only when storage throws. */
  private writeSessionId(key: string): string {
    const id = newSessionId();
    try {
      sessionStorage.setItem(key, id);
    } catch {
      // Storage is unavailable; the in-memory id still scopes this mount.
    }
    return id;
  }

  private rotateSessionId(): string {
    const key = `${SESSION_PREFIX}${this.getAttribute('endpoint') ?? ''}`;
    try {
      sessionStorage.removeItem(key);
    } catch {
      // ignore
    }
    return this.writeSessionId(key);
  }

  private setStreaming(streaming: boolean): void {
    if (this.inputEl === null || this.sendEl === null) return;
    this.inputEl.disabled = streaming;
    this.sendEl.type = streaming ? 'button' : 'submit';
    this.sendEl.textContent = streaming ? 'Stop' : 'Send';
  }

  private endTurn(): void {
    this.turn = null;
    this.setStreaming(false);
  }

  private async streamTurn(text: string, signal: AbortSignal): Promise<void> {
    const endpoint = this.getAttribute('endpoint');
    if (endpoint === null || endpoint === '') throw new Error('forge-chat: endpoint attribute is required');
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: requestHeaders(this.getAttribute('token')),
      body: JSON.stringify({ sessionId: this.sessionId(), input: text }),
      signal,
    });
    if (!response.ok) {
      errorText(this.refs!, httpErrorText(response.status));
      return;
    }
    if (response.body !== null) await this.readTurn(response.body);
  }

  /** Reads the SSE body to its `done` frame (or an early stop), applying each AgentEvent to the log. */
  private async readTurn(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser();
    const refs = this.refs!;
    let stop = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        const chunks = done
          ? [...parser.push(decoder.decode()), ...parser.flush()]
          : parser.push(decoder.decode(value, { stream: true }));
        for (const frame of chunks) {
          if (frame.event === 'done' || applyFrame(refs, parseAgentEvent(frame))) {
            stop = true;
            break;
          }
        }
        if (done || stop) break;
      }
    } finally {
      if (stop) await reader.cancel().catch(() => {});
    }
  }
}

function parseAgentEvent(frame: SseFrame): AgentEventLike {
  try {
    const parsed: unknown = JSON.parse(frame.data);
    return typeof parsed === 'object' && parsed !== null ? (parsed as AgentEventLike) : {};
  } catch {
    return {};
  }
}

function requestHeaders(token: string | null): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    ...(token !== null && token !== '' ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function httpErrorText(status: number): string {
  if (status === 401) return 'The chat token is missing or wrong.';
  if (status === 404) return 'This agent is not being served right now.';
  return `The agent could not answer (HTTP ${status}).`;
}

/** Registers `<forge-chat>` once; a no-op when the tag is already defined. */
export function defineForgeChat(registry: CustomElementRegistry = customElements): void {
  if (!registry.get(FORGE_CHAT_TAG)) registry.define(FORGE_CHAT_TAG, ForgeChatElement);
}
