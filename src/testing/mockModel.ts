/**
 * Scripted mock model: a deterministic, typed `LLMProvider` test double.
 *
 * Script the model's replies turn by turn, run your agent, then assert on the
 * exact requests the agent sent. No network, no randomness.
 */

import type {
  GenerateOptions,
  GenerateResult,
  HostedToolCall,
  LLMProvider,
  Message,
  StreamChunk,
  StreamResult,
  ToolCall,
} from '../providers/llm';
import { textOf } from '../providers/content';
import { SDKError } from '../execution/errors';

/** Recursively read-only version of `T` (used for recorded requests). */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends ReadonlyArray<infer U>
    ? ReadonlyArray<DeepReadonly<U>>
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

/** A request recorded by {@link MockModel}: a deep-frozen snapshot of the `generate()` options. */
export type MockRequest = DeepReadonly<GenerateOptions>;

/**
 * A tool call the mock model should emit.
 *
 * @example
 * ```ts
 * const call: MockToolCall = { name: 'get_weather', args: { city: 'Paris' } };
 * ```
 */
export interface MockToolCall {
  /** Name of the tool to call. */
  name: string;
  /** Arguments for the tool; serialized to JSON for the agent. Defaults to `{}`. */
  args?: Readonly<Record<string, unknown>>;
  /** Tool-call id. Defaults to a stable `call_1`, `call_2`, ... sequence. */
  id?: string;
}

/**
 * N1a: a hosted tool call the mock "provider" ran this turn (as a real
 * provider runs `webSearch()`): reported in events with `executedBy: 'provider'`,
 * never executed by the agent.
 *
 * @example
 * ```ts
 * const call: MockHostedToolCall = { name: 'web_search', args: { query: 'lousho' }, result: { results: [] } };
 * ```
 */
export interface MockHostedToolCall {
  /** The hosted tool's name, e.g. `web_search`. */
  name: string;
  /** The input the model gave the tool. Defaults to `{}`. */
  args?: unknown;
  /** The provider's result. */
  result?: unknown;
  /** Report the call as failed (`result` is the error). */
  isError?: boolean;
  /** URL sources the provider cited. */
  sources?: Array<{ url: string; title?: string }>;
  /** Call id. Defaults to `hosted_1`, `hosted_2`, ... (sharing the tool-call counter). */
  id?: string;
}

/**
 * One scripted model reply (object form).
 *
 * @example
 * ```ts
 * const turn: MockTurnObject = {
 *   toolCalls: [{ name: 'search', args: { q: 'cats' } }],
 *   usage: { inputTokens: 10, outputTokens: 5 },
 * };
 * ```
 */
export interface MockTurnObject {
  /** Assistant text. Defaults to an empty string. */
  text?: string;
  /** Tool calls the model requests this turn. */
  toolCalls?: readonly MockToolCall[];
  /** N1a: hosted tool calls the provider ran this turn (reported before the text; never run by the agent). */
  hostedToolCalls?: readonly MockHostedToolCall[];
  /** Make `generate()` / `stream()` reject with this error instead of replying. */
  error?: Error;
  /**
   * Token usage to report. When omitted the model reports no usage at all, like a
   * backend that omits token counts (the executor then estimates and flags it).
   */
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; cacheWriteTokens?: number };
  /** Finish reason to report. Defaults to `'tool_calls'` when there are tool calls, else `'stop'`. */
  finishReason?: GenerateResult['finishReason'];
  /**
   * Wait this many milliseconds before answering. Eve CORE-F15: the wait
   * ends early, rejecting with the signal's reason, when the request's
   * `signal` aborts (unless `ignoreSignal`).
   */
  delayMs?: number;
  /**
   * Eve CORE-F15: act like a provider without cancellation support: wait out
   * `delayMs` and answer even after the request's `signal` aborted.
   */
  ignoreSignal?: boolean;
}

/** A non-dynamic turn: a bare string (shorthand for `{ text }`) or a {@link MockTurnObject}. */
export type MockStaticTurn = string | MockTurnObject;

/**
 * A scripted turn: a string, a {@link MockTurnObject}, or a function that
 * builds either from the incoming request (sync or async).
 *
 * @example
 * ```ts
 * const echo: MockTurn = (req) => `You said: ${req.messages.at(-1)?.content}`;
 * ```
 */
export type MockTurn =
  | MockStaticTurn
  | ((request: MockRequest) => MockStaticTurn | Promise<MockStaticTurn>);

/** Options for {@link mockModel}. */
export interface MockModelOptions {
  /**
   * What to do when the script runs out. `'throw'` (default) rejects with a
   * descriptive error; `'repeat-last'` replays the final turn forever.
   */
  onExhausted?: 'throw' | 'repeat-last';
  /** Reported as the provider's `defaultModel`. Defaults to `'mock-model'`. */
  defaultModel?: string;
}

/**
 * A scripted `LLMProvider` that records every request.
 *
 * @example
 * ```ts
 * const model = mockModel(['Hello!']);
 * await model.generate({ messages: [{ role: 'user', content: 'hi' }] });
 * model.assertExhausted();
 * ```
 */
export interface MockModel extends LLMProvider {
  /** Every `generate()` / `stream()` request so far, in order, as deep-frozen snapshots. */
  readonly calls: readonly MockRequest[];
  /** The most recent request, or `undefined` before the first call. */
  readonly lastCall: MockRequest | undefined;
  /** Rewind the script, clear recorded calls and restart generated tool-call ids at `call_1`. */
  reset(): void;
  /**
   * Throw if scripted turns remain unused.
   *
   * @example
   * ```ts
   * model.assertExhausted(); // fails the test if the agent made fewer calls than scripted
   * ```
   */
  assertExhausted(): void;
}

interface ResolvedTurn {
  text: string;
  toolCalls: ToolCall[];
  hostedToolCalls: HostedToolCall[];
  finishReason: GenerateResult['finishReason'];
  usage: GenerateResult['usage'];
  /** Eve CORE-F15: the request's signal, which a stream checks between chunks (unset for an `ignoreSignal` turn). */
  signal?: AbortSignal;
}

/**
 * Copy plain objects and arrays (freezing the copies) while keeping anything
 * else (functions, class instances such as zod schemas in tool definitions)
 * by reference, since those cannot be structurally cloned.
 */
function cloneFrozen(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneFrozen));
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const copy: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) copy[key] = cloneFrozen(child);
    return Object.freeze(copy);
  }
  return value;
}

function snapshot(options: GenerateOptions): MockRequest {
  return cloneFrozen(options) as MockRequest;
}

function describeLastMessage(request: MockRequest): string {
  const last = request.messages.at(-1);
  if (!last) return '(no messages)';
  const text = textOf(last as Pick<Message, 'content'>);
  const content = text.length > 120 ? `${text.slice(0, 117)}...` : text;
  return `${last.role}: ${JSON.stringify(content)}`;
}

function toStaticTurn(turn: MockStaticTurn): MockTurnObject {
  return typeof turn === 'string' ? { text: turn } : turn;
}

/** Eve CORE-F15: waits `ms`, rejecting with `signal`'s reason as soon as it aborts. */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function chunkText(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

class ScriptedMockModel implements MockModel {
  readonly name = 'mock';
  readonly defaultModel: string;
  private readonly recorded: MockRequest[] = [];
  private index = 0;
  private idCounter = 0;

  constructor(
    private readonly script: readonly MockTurn[],
    private readonly options: MockModelOptions
  ) {
    this.defaultModel = options.defaultModel ?? 'mock-model';
  }

  get calls(): readonly MockRequest[] {
    return this.recorded;
  }

  get lastCall(): MockRequest | undefined {
    return this.recorded.at(-1);
  }

  reset(): void {
    this.recorded.length = 0;
    this.index = 0;
    this.idCounter = 0;
  }

  assertExhausted(): void {
    const remaining = this.script.length - this.index;
    if (remaining > 0) {
      throw new SDKError(
        `mockModel: ${remaining} scripted turn(s) were never used (${this.index} of ${this.script.length} consumed). ` +
          'Remove the extra turns or check why the agent stopped calling the model early.',
        'LOUSHO_TEST_FAILED'
      );
    }
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const turn = await this.resolve(options);
    return {
      text: turn.text,
      finishReason: turn.finishReason,
      usage: turn.usage,
      ...(turn.toolCalls.length > 0 ? { toolCalls: turn.toolCalls } : {}),
      ...(turn.hostedToolCalls.length > 0 && { hostedToolCalls: turn.hostedToolCalls }),
    };
  }

  async stream(options: GenerateOptions): Promise<StreamResult> {
    const turn = await this.resolve(options);
    const chunks = chunkText(turn.text);
    const fullStream = async function* (): AsyncGenerator<StreamChunk> {
      for (const hostedToolCall of turn.hostedToolCalls) {
        turn.signal?.throwIfAborted();
        const { result: _result, isError: _isError, sources: _sources, ...started } = hostedToolCall;
        yield { type: 'hosted-tool-call', hostedToolCall: started };
        yield { type: 'hosted-tool-result', hostedToolCall };
      }
      for (const textDelta of chunks) {
        turn.signal?.throwIfAborted();
        yield { type: 'text-delta', textDelta };
      }
      turn.signal?.throwIfAborted();
      for (const toolCall of turn.toolCalls) yield { type: 'tool-call', toolCall };
      yield { type: 'finish', finishReason: turn.finishReason, usage: turn.usage };
    };
    const textStream = async function* (): AsyncGenerator<string> {
      yield* chunks;
    };
    return {
      fullStream: fullStream(),
      textStream: textStream(),
      text: Promise.resolve(turn.text),
      usage: Promise.resolve(turn.usage),
      finishReason: Promise.resolve(turn.finishReason),
      toolCalls: Promise.resolve(turn.toolCalls),
    };
  }

  supportsTools(): boolean {
    return true;
  }

  supportsStreaming(): boolean {
    return true;
  }

  /** N1a: the mock takes every hosted tool; a turn scripts the calls it "ran" (`hostedToolCalls`). */
  supportsHostedTool(): boolean {
    return true;
  }

  async getModels(): Promise<string[]> {
    return [this.defaultModel];
  }

  private async resolve(options: GenerateOptions): Promise<ResolvedTurn> {
    const request = snapshot(options);
    this.recorded.push(request);
    const turn = toStaticTurn(await this.nextTurn(request));
    // Eve CORE-F15: a cancelled request rejects with the signal's reason, like a real provider's.
    const signal = turn.ignoreSignal ? undefined : options.signal;
    signal?.throwIfAborted();
    if (turn.delayMs) await delay(turn.delayMs, signal);
    if (turn.error) throw turn.error;
    return { ...this.toResolved(turn), ...(signal && { signal }) };
  }

  private async nextTurn(request: MockRequest): Promise<MockStaticTurn> {
    const callNumber = this.recorded.length;
    let scripted = this.script[this.index];
    if (scripted === undefined) {
      if (this.options.onExhausted === 'repeat-last' && this.script.length > 0) {
        scripted = this.script[this.script.length - 1];
      } else {
        throw this.exhaustedError(callNumber, request);
      }
    } else {
      this.index++;
    }
    return typeof scripted === 'function' ? scripted(request) : scripted;
  }

  private exhaustedError(callNumber: number, request: MockRequest): Error {
    return new Error(
      `mockModel: unexpected call #${callNumber} - the script only has ${this.script.length} turn(s). ` +
        `Last message of this request: ${describeLastMessage(request)}. ` +
        "Add another turn to the script, or pass { onExhausted: 'repeat-last' } to replay the final turn."
    );
  }

  private toResolved(turn: MockTurnObject): ResolvedTurn {
    const toolCalls = (turn.toolCalls ?? []).map((call) => this.toToolCall(call));
    return {
      text: turn.text ?? '',
      toolCalls,
      hostedToolCalls: (turn.hostedToolCalls ?? []).map((call) => this.toHostedCall(call)),
      finishReason: turn.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
      usage: turn.usage && {
        promptTokens: turn.usage.inputTokens,
        completionTokens: turn.usage.outputTokens,
        totalTokens: turn.usage.inputTokens + turn.usage.outputTokens,
        ...(turn.usage.cachedInputTokens !== undefined && { cachedInputTokens: turn.usage.cachedInputTokens }),
        ...(turn.usage.cacheWriteTokens !== undefined && { cacheWriteTokens: turn.usage.cacheWriteTokens }),
      },
    };
  }

  private toHostedCall({ id, name, args, result, isError, sources }: MockHostedToolCall): HostedToolCall {
    return {
      id: id ?? `hosted_${++this.idCounter}`,
      name,
      args: args ?? {},
      ...(result !== undefined && { result }),
      ...(isError && { isError: true }),
      ...(sources && { sources: sources.map((source) => ({ ...source })) }),
    };
  }

  private toToolCall(call: MockToolCall): ToolCall {
    return {
      id: call.id ?? `call_${++this.idCounter}`,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
    };
  }
}

/**
 * Create a scripted, deterministic `LLMProvider` for unit-testing agents.
 *
 * Each `generate()` / `stream()` call consumes the next turn of `script`.
 * Tool-call ids are generated as `call_1`, `call_2`, ... unless you give one.
 * Every request is recorded (deep-frozen) on `model.calls`.
 *
 * @param script - Turns to replay, in order. A bare string means `{ text }`.
 * @param options - See {@link MockModelOptions}.
 *
 * @example
 * ```ts
 * import { mockModel } from '@lousho/build-ai-agent/testing';
 *
 * const model = mockModel([
 *   { toolCalls: [{ name: 'get_weather', args: { city: 'Paris' } }] },
 *   { text: 'It is 21°C in Paris.' },
 * ]);
 * const agent = createAgent({ prompt: '...', provider: model, tools });
 * await agent.send('Weather in Paris?');
 *
 * expect(model.calls).toHaveLength(2);
 * model.assertExhausted();
 * ```
 */
export function mockModel(script: readonly MockTurn[], options: MockModelOptions = {}): MockModel {
  return new ScriptedMockModel(script, options);
}
