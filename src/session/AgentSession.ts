/**
 * AgentSession (LOU-W4): a multi-turn conversation on top of the stateless
 * executor. The session owns the transcript and passes it in on every
 * `send()`; it does not use checkpoints or resume.
 */

import { randomUUID } from 'node:crypto';
import type { Message } from '../providers/llm';
import type { ExecutionResult } from '../execution/AgentExecutor';
import { MemorySessionStore, assertSessionId, type SessionStore } from './sessionStore';

/** Options for `agent.session()`. */
export interface SessionOptions {
  /**
   * Session id (1-128 characters of `A-Za-z0-9_-`). Defaults to a generated
   * UUID. Passing an id that exists in `store` continues that conversation.
   */
  id?: string;
  /** Where the transcript is kept. Defaults to a new `MemorySessionStore`. */
  store?: SessionStore;
}

/**
 * Runs one turn: `input` is the whole transcript so far, ending in the new
 * user message. Supplied by `createAgent()`.
 */
export type SessionRunner = (input: Message[], signal?: AbortSignal) => Promise<ExecutionResult>;

/**
 * Longest prefix of `messages` that a provider accepts: every assistant
 * tool-call turn is followed by a result for each of its calls, and no tool
 * message is orphaned.
 */
export function providerValidPrefix(messages: readonly Message[]): Message[] {
  let i = 0;
  while (i < messages.length) {
    const message = messages[i];
    if (message.role === 'tool') break;
    const calls = message.role === 'assistant' ? (message.toolCalls ?? []) : [];
    if (calls.length === 0) {
      i += 1;
      continue;
    }
    let end = i + 1;
    const answered = new Set<string>();
    while (end < messages.length && messages[end].role === 'tool') {
      answered.add(messages[end].toolCallId ?? '');
      end += 1;
    }
    if (!calls.every((call) => answered.has(call.id))) break;
    i = end;
  }
  return messages.slice(0, i);
}

/**
 * A conversation that remembers earlier turns. Create one with
 * `agent.session()`.
 *
 * @example
 * ```ts
 * const session = agent.session();
 * await session.send('My name is Ali.');
 * const { text } = await session.send('What is my name?');
 * ```
 */
export class AgentSession {
  readonly id: string;
  private readonly store: SessionStore;
  private readonly run: SessionRunner;
  private history: Message[] = [];
  private loaded = false;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(run: SessionRunner, options: SessionOptions = {}) {
    if (options.id !== undefined) assertSessionId(options.id);
    this.id = options.id ?? randomUUID();
    this.store = options.store ?? new MemorySessionStore();
    this.run = run;
  }

  /**
   * Snapshot of the transcript so far (no system prompt). For a session
   * continued from a store it is empty until the first `send()` or
   * `load()` has completed.
   */
  get messages(): readonly Message[] {
    return structuredClone(this.history);
  }

  /** Read the saved transcript from the store (done automatically by `send()`). */
  async load(): Promise<readonly Message[]> {
    await this.enqueue(() => this.ensureLoaded());
    return this.messages;
  }

  /**
   * Send a user message with the whole conversation so far. Concurrent calls
   * run one after another, in call order.
   *
   * A call that throws or is aborted leaves the transcript as it was before
   * the call (an aborted call resolves with `finishReason: 'aborted'`).
   *
   * @example
   * ```ts
   * const result = await session.send('And in Paris?', { signal: AbortSignal.timeout(10_000) });
   * ```
   */
  send(input: string, options: { signal?: AbortSignal } = {}): Promise<ExecutionResult> {
    return this.enqueue(() => this.turn(input, options.signal));
  }

  /** Forget the conversation (also deletes it from the store). */
  clear(): Promise<void> {
    return this.enqueue(async () => {
      await this.store.delete(this.id);
      this.history = [];
      this.loaded = true;
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.history = (await this.store.load(this.id)) ?? [];
    this.loaded = true;
  }

  private async turn(input: string, signal?: AbortSignal): Promise<ExecutionResult> {
    await this.ensureLoaded();
    const result = await this.run([...this.history, { role: 'user', content: input }], signal);
    if (result.finishReason === 'aborted') return result;
    const withoutSystem = result.messages[0]?.role === 'system' ? result.messages.slice(1) : result.messages;
    const next = providerValidPrefix(withoutSystem);
    await this.store.save(this.id, next);
    this.history = next;
    return result;
  }
}
