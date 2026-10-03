/**
 * `recordReplay`: a VCR for `LLMProvider`s. Run once against a real model and
 * record every exchange to a cassette file; replay it in CI with no network
 * and no API key.
 */

import * as fs from 'node:fs';
import type {
  GenerateOptions,
  GenerateResult,
  LLMProvider,
  ProviderUsage,
  StreamChunk,
  StreamResult,
} from '../providers/llm';
import {
  RERECORD_HINT,
  newCassette,
  readCassette,
  writeCassette,
  type Cassette,
  type CassetteEntry,
  type CassetteError,
  type CassetteRequest,
  type CassetteResponse,
} from './cassette';
import { createSanitizer, firstDifference, stableStringify, type Sanitizer } from './fingerprint';
import { SDKError } from '../execution/errors';
import type { HostedToolType } from '../tools/hosted';
import type { HostedToolCall } from '../providers/llm';

/** Whether a {@link recordReplay} provider records or replays. */
export type RecordReplayMode = 'record' | 'replay' | 'auto';

/** The provider to wrap: an instance, a lazy factory, or `undefined` (replay only). */
export type RecordReplaySource = LLMProvider | (() => LLMProvider) | undefined;

/** Options for {@link recordReplay}. */
export interface RecordReplayOptions {
  /** Path of the cassette JSON file. Its directory is created when recording. */
  cassette: string;
  /**
   * - `'record'`: call the wrapped provider and write the cassette (replacing any old one).
   * - `'replay'`: never call the wrapped provider; serve the recorded responses.
   * - `'auto'` (default): replay if the cassette file exists, else record.
   */
  mode?: RecordReplayMode;
  /**
   * How replay finds the entry for a call. `'sequence'` (default): entry N
   * answers call N, and the request must still match. `'request'`: look the
   * entry up by request fingerprint regardless of order (parallel calls).
   */
  match?: 'sequence' | 'request';
  /**
   * Rewrite a request before it is fingerprinted and stored, e.g. to blank a
   * value that changes every run. Runs before the built-in normalization.
   */
  normalize?: (request: GenerateOptions) => GenerateOptions;
  /**
   * Redact text before it is stored (applied to every recorded string, after
   * the built-in API-key redaction).
   */
  redact?: (text: string) => string;
  /** Replay `stream()` with the recorded inter-chunk delays. Default `false` (no delays). */
  replayTiming?: boolean;
}

/**
 * A recording/replaying `LLMProvider`.
 *
 * @example
 * ```ts
 * const provider = recordReplay(() => resolveProvider('openai/gpt-4o-mini'), {
 *   cassette: './__cassettes__/refund-flow.json',
 *   mode: process.env.LOUSHO_RECORD ? 'record' : 'replay',
 * });
 * ```
 */
export interface RecordReplayProvider extends LLMProvider {
  /** The mode in effect (`'auto'` is resolved at construction). */
  readonly mode: 'record' | 'replay';
  /**
   * Write the cassette now. Recording already writes after every call, so this
   * is only needed to force a write (for example when no call was made).
   * A no-op in replay mode.
   */
  save(): Promise<void>;
}

/**
 * Thrown in replay mode when a request does not match the cassette (or it ran
 * out of entries). It is a `LOUSHO_CASSETTE_INVALID` SDKError (docs/errors.md)
 * and AgentExecutor never compacts it into a provider error: through
 * `agent.send()` it reaches the caller typed, with `.cassette`/`.callNumber`
 * intact (LOU-R13).
 */
export class CassetteMismatchError extends SDKError {
  constructor(
    message: string,
    /** The cassette file. */
    readonly cassette: string,
    /** 1-based number of the call that failed to match. */
    readonly callNumber: number
  ) {
    super(message, 'LOUSHO_CASSETTE_INVALID');
    this.name = 'CassetteMismatchError';
  }
}

function toCassetteError(error: unknown, sanitizer: Sanitizer): CassetteError {
  const err = error instanceof Error ? error : new Error(String(error));
  return sanitizer.redact({ name: err.name, message: err.message });
}

function fromCassetteError(error: CassetteError): Error {
  const err = new Error(error.message);
  err.name = error.name;
  return err;
}

type StoredChunk = NonNullable<CassetteResponse['chunks']>[number]['chunk'];

function serializeChunk(chunk: StreamChunk): StoredChunk {
  return {
    type: chunk.type,
    ...(chunk.textDelta !== undefined ? { textDelta: chunk.textDelta } : {}),
    ...(chunk.reasoning ? { reasoning: chunk.reasoning } : {}),
    ...(chunk.toolCall ? { toolCall: chunk.toolCall } : {}),
    ...(chunk.hostedToolCall ? { hostedToolCall: clone(chunk.hostedToolCall) } : {}),
    ...(chunk.toolResult ? { toolResult: chunk.toolResult } : {}),
    ...(chunk.finishReason !== undefined ? { finishReason: chunk.finishReason } : {}),
    ...(chunk.usage ? { usage: chunk.usage } : {}),
    ...(chunk.error ? { error: { name: chunk.error.name, message: chunk.error.message } } : {}),
  };
}

function deserializeChunk(stored: StoredChunk): StreamChunk {
  const { error, toolResult, hostedToolCall, ...rest } = stored;
  return {
    ...rest,
    // A stored hosted call always has `args` (JSON), which the schema types as optional.
    ...(hostedToolCall ? { hostedToolCall: hostedToolCall as HostedToolCall } : {}),
    ...(toolResult ? { toolResult: { toolCallId: toolResult.toolCallId, result: toolResult.result } } : {}),
    ...(error ? { error: fromCassetteError(error) } : {}),
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Only the token counts are stored; a call that reported no usage records none. */
function recordedUsage(usage: ProviderUsage | undefined): { usage?: ProviderUsage } {
  if (!usage) return {};
  const { promptTokens, completionTokens, totalTokens } = usage;
  return { usage: { promptTokens, completionTokens, totalTokens } };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Rebuild a `StreamResult` from a recorded stream entry. */
function replayStream(response: CassetteResponse, replayTiming: boolean): StreamResult {
  const chunks = response.chunks ?? [];
  const fullStream = async function* (): AsyncGenerator<StreamChunk> {
    for (const { delayMs, chunk } of chunks) {
      if (replayTiming && delayMs > 0) await sleep(delayMs);
      yield deserializeChunk(clone(chunk));
    }
  };
  const textStream = async function* (): AsyncGenerator<string> {
    for await (const chunk of fullStream()) {
      if (chunk.type === 'text-delta' && chunk.textDelta !== undefined) yield chunk.textDelta;
    }
  };
  return {
    fullStream: fullStream(),
    textStream: textStream(),
    text: Promise.resolve(response.text),
    usage: Promise.resolve(response.usage && clone(response.usage)),
    finishReason: Promise.resolve(response.finishReason),
    toolCalls: Promise.resolve(clone(response.toolCalls ?? [])),
  };
}

function toGenerateResult(response: CassetteResponse): GenerateResult {
  return {
    text: response.text,
    finishReason: response.finishReason as GenerateResult['finishReason'],
    ...(response.usage ? { usage: clone(response.usage) } : {}),
    ...(response.toolCalls?.length ? { toolCalls: clone(response.toolCalls) } : {}),
    ...(response.hostedToolCalls?.length ? { hostedToolCalls: clone(response.hostedToolCalls) as HostedToolCall[] } : {}),
  };
}

class Recorder implements RecordReplayProvider {
  readonly mode = 'record';
  readonly name: string;
  readonly defaultModel: string | undefined;
  private readonly cassette: Cassette;
  private readonly slots: Array<CassetteEntry | undefined> = [];
  private readonly sanitizer: Sanitizer;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly provider: LLMProvider,
    private readonly options: RecordReplayOptions
  ) {
    this.name = provider.name;
    this.defaultModel = provider.defaultModel;
    this.cassette = newCassette({
      name: provider.name,
      ...(provider.defaultModel ? { defaultModel: provider.defaultModel } : {}),
    });
    this.sanitizer = createSanitizer({
      normalize: options.normalize,
      redact: options.redact,
      defaultModel: provider.defaultModel,
    });
  }

  generate(options: GenerateOptions): Promise<GenerateResult> {
    return this.record('generate', options, async () => {
      const result = await this.provider.generate(options);
      return { result, response: this.generateResponse(result) };
    });
  }

  stream(options: GenerateOptions): Promise<StreamResult> {
    return this.record('stream', options, async () => {
      const recorded = await this.consumeStream(await this.provider.stream(options));
      return { result: replayStream(recorded, false), response: recorded };
    });
  }

  supportsTools(model: string): boolean {
    return this.provider.supportsTools(model);
  }

  supportsStreaming(model: string): boolean {
    return this.provider.supportsStreaming(model);
  }

  /** N1a: the recorded provider's answer. */
  supportsHostedTool(type: HostedToolType | 'custom'): boolean {
    return this.provider.supportsHostedTool?.(type) ?? false;
  }

  getModels(): Promise<string[]> {
    return this.provider.getModels();
  }

  async save(): Promise<void> {
    this.cassette.entries = this.slots.filter((entry): entry is CassetteEntry => entry !== undefined);
    const snapshot = clone(this.cassette);
    this.writing = this.writing.catch(() => undefined).then(() => writeCassette(this.options.cassette, snapshot));
    await this.writing;
  }

  private async record<T>(
    kind: CassetteEntry['kind'],
    options: GenerateOptions,
    call: () => Promise<{ result: T; response: CassetteResponse }>
  ): Promise<T> {
    const request = this.sanitizer.request(options);
    const slot = this.slots.length;
    this.slots.push(undefined);
    let outcome: { result: T; response: CassetteResponse };
    try {
      outcome = await call();
    } catch (error) {
      this.slots[slot] = { kind, request, error: toCassetteError(error, this.sanitizer) };
      await this.save();
      throw error;
    }
    this.slots[slot] = { kind, request, response: outcome.response };
    await this.save();
    return outcome.result;
  }

  private generateResponse(result: GenerateResult): CassetteResponse {
    // rawResponse is deliberately not recorded: it can carry headers and ids.
    return this.sanitizer.redact({
      text: result.text,
      finishReason: result.finishReason,
      ...recordedUsage(result.usage),
      ...(result.toolCalls?.length ? { toolCalls: result.toolCalls } : {}),
      ...(result.hostedToolCalls?.length ? { hostedToolCalls: clone(result.hostedToolCalls) } : {}),
    });
  }

  private async consumeStream(stream: StreamResult): Promise<CassetteResponse> {
    const chunks: NonNullable<CassetteResponse['chunks']> = [];
    let last = performance.now();
    for await (const chunk of stream.fullStream) {
      const now = performance.now();
      chunks.push({ delayMs: Math.round(now - last), chunk: serializeChunk(chunk) });
      last = now;
    }
    const [text, usage, finishReason, toolCalls] = await Promise.all([
      stream.text,
      stream.usage,
      stream.finishReason,
      stream.toolCalls,
    ]);
    return this.sanitizer.redact({
      text,
      finishReason,
      ...recordedUsage(usage),
      ...(toolCalls.length ? { toolCalls } : {}),
      chunks,
    });
  }
}

class Player implements RecordReplayProvider {
  readonly mode = 'replay';
  readonly name: string;
  readonly defaultModel: string | undefined;
  private readonly cassette: Cassette;
  private readonly sanitizer: Sanitizer;
  private readonly used = new Set<number>();
  private calls = 0;

  constructor(
    provider: LLMProvider | undefined,
    private readonly options: RecordReplayOptions
  ) {
    this.cassette = readCassette(options.cassette);
    const identity: { name: string; defaultModel?: string } = provider ?? this.cassette.provider;
    this.name = identity.name;
    this.defaultModel = identity.defaultModel;
    this.sanitizer = createSanitizer({
      normalize: options.normalize,
      redact: options.redact,
      defaultModel: this.defaultModel,
    });
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    return toGenerateResult(this.take('generate', options));
  }

  async stream(options: GenerateOptions): Promise<StreamResult> {
    return replayStream(this.take('stream', options), this.options.replayTiming ?? false);
  }

  supportsTools(): boolean {
    return true;
  }

  supportsStreaming(): boolean {
    return true;
  }

  /** N1a: a replay answers with whatever was recorded. */
  supportsHostedTool(): boolean {
    return true;
  }

  async getModels(): Promise<string[]> {
    return this.defaultModel ? [this.defaultModel] : [];
  }

  async save(): Promise<void> {
    // Replay never writes.
  }

  private take(kind: CassetteEntry['kind'], options: GenerateOptions): CassetteResponse {
    if (options.signal?.aborted) throw options.signal.reason;
    const request = this.sanitizer.request(options);
    const callNumber = ++this.calls;
    const index =
      this.options.match === 'request'
        ? this.findByRequest(kind, request, callNumber)
        : this.findNext(kind, request, callNumber);
    this.used.add(index);
    const entry = this.cassette.entries[index];
    if (entry.error) throw fromCassetteError(entry.error);
    return entry.response as CassetteResponse;
  }

  private findNext(kind: CassetteEntry['kind'], request: CassetteRequest, callNumber: number): number {
    const index = callNumber - 1;
    const entry = this.cassette.entries[index];
    if (!entry) throw this.exhausted(callNumber);
    this.assertSame(entry, kind, request, callNumber);
    return index;
  }

  private findByRequest(kind: CassetteEntry['kind'], request: CassetteRequest, callNumber: number): number {
    const key = stableStringify({ kind, request });
    const index = this.cassette.entries.findIndex(
      (entry, i) => !this.used.has(i) && stableStringify({ kind: entry.kind, request: entry.request }) === key
    );
    if (index >= 0) return index;
    const firstUnused = this.cassette.entries.findIndex((_, i) => !this.used.has(i));
    if (firstUnused < 0) throw this.exhausted(callNumber);
    this.assertSame(this.cassette.entries[firstUnused], kind, request, callNumber, 'No unused recorded request matches. ');
    throw this.exhausted(callNumber);
  }

  private assertSame(
    entry: CassetteEntry,
    kind: CassetteEntry['kind'],
    request: CassetteRequest,
    callNumber: number,
    prefix = ''
  ): void {
    const diff = firstDifference({ kind: entry.kind, request: entry.request }, { kind, request });
    if (!diff) return;
    throw new CassetteMismatchError(
      `${prefix}Call #${callNumber} does not match the recorded request in ${this.options.cassette}.\n` +
        `First difference at ${diff.path}:\n  recorded: ${diff.expected}\n  actual:   ${diff.actual}\n` +
        RERECORD_HINT,
      this.options.cassette,
      callNumber
    );
  }

  private exhausted(callNumber: number): CassetteMismatchError {
    const total = this.cassette.entries.length;
    return new CassetteMismatchError(
      `Call #${callNumber} has no recorded entry: ${this.options.cassette} holds ${total} ` +
        `entr${total === 1 ? 'y' : 'ies'} and all were used. The agent now makes more model calls than when ` +
        `it was recorded. ${RERECORD_HINT}`,
      this.options.cassette,
      callNumber
    );
  }
}

function resolveMode(options: RecordReplayOptions): 'record' | 'replay' {
  const mode = options.mode ?? 'auto';
  if (mode === 'auto') return fs.existsSync(options.cassette) ? 'replay' : 'record';
  return mode;
}

/**
 * Wrap an `LLMProvider` so its exchanges are recorded to a cassette file and
 * later replayed deterministically, with no network and no API key.
 *
 * Record mode forwards to the real provider and writes the cassette atomically
 * (temp file plus rename) after every call, so a test that fails midway leaves
 * a valid cassette holding every call made so far; there is no exit hook.
 * Provider errors are recorded and replayed as rejections with the same
 * name and message. Replay mode never touches the wrapped provider, so pass a
 * factory (or `undefined`) and CI needs neither the key nor the peer package.
 *
 * Cassettes are meant to be committed: API-key-like strings (`sk-...`,
 * `sk-ant-...`, bearer tokens) are redacted, `rawResponse` is never stored and
 * only whitelisted request fields are written. Use `redact` for anything else
 * sensitive in your prompts.
 *
 * @param provider - The real provider, a `() => LLMProvider` factory (called
 *   only when recording), or `undefined` when you only ever replay.
 * @param options - See {@link RecordReplayOptions}.
 * @throws In replay mode, if the cassette is missing, malformed or has the
 *   wrong version. Replayed calls throw {@link CassetteMismatchError}.
 *
 * @example
 * ```ts
 * import { recordReplay } from '@lousho/build-ai-agent/testing';
 *
 * const provider = recordReplay(() => resolveProvider('openai/gpt-4o-mini'), {
 *   cassette: './__cassettes__/refund-flow.json',
 *   mode: process.env.LOUSHO_RECORD ? 'record' : 'replay',
 * });
 * const agent = createAgent({ provider, prompt: 'You handle refunds.' });
 * ```
 */
export function recordReplay(provider: RecordReplaySource, options: RecordReplayOptions): RecordReplayProvider {
  // Replay must never construct the provider: a factory is only ever called when recording.
  if (resolveMode(options) === 'replay') return new Player(typeof provider === 'function' ? undefined : provider, options);
  const real = typeof provider === 'function' ? provider() : provider;
  if (!real) {
    throw new SDKError(
      "recordReplay: record mode needs a provider to record from, but none was given. Pass the real provider (or a () => provider factory) as the first argument, or use mode: 'replay'.",
      'LOUSHO_CONFIG_INVALID'
    );
  }
  return new Recorder(real, options);
}
