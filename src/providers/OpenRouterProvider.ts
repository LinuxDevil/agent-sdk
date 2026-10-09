/**
 * OpenRouter Provider Implementation
 * Uses OpenAI-compatible API through the 'ai' SDK (shared logic in ./aiSdkProvider)
 */

import { LanguageModel } from 'ai';
import { AiSdkProvider, AiSdkProviderConfig } from './aiSdkProvider';
import { aiMajorOf } from './aiSdkCompat';
import { lazyValue, loadOptionalPeer } from './optionalPeer';
import { Logger, noopLogger } from '../execution/logger';
import { SDKError } from '../execution/errors';
import type { GenerateOptions, GenerateResult, HostedToolCall, ProviderUsage, ReasoningBlock, StreamChunk, StreamResult } from './llm';
import { openRouterReasoning } from './reasoning';
import { mappedHostedOptions, type HostedOptionMapping } from './hostedToolMapping';
import { hostedToolUnsupported, type HostedTool, type HostedToolType } from '../tools/hosted';

export interface OpenRouterProviderConfig extends AiSdkProviderConfig {
  apiKey: string;
  siteUrl?: string;
  siteName?: string;
  defaultModel?: string;
}

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1';

/** One entry of OpenRouter's GET /models catalog: its `id`, plus the other fields as sent (pricing, context length, ...). */
export interface OpenRouterModel {
  id: string;
  [key: string]: unknown;
}

/**
 * Build headers with optional site attribution
 */
function buildHeaders(config: OpenRouterProviderConfig): Record<string, string> {
  const headers: Record<string, string> = {
    ...(config.headers || {}),
  };

  if (config.siteUrl) {
    headers['HTTP-Referer'] = config.siteUrl;
  }

  if (config.siteName) {
    headers['X-Title'] = config.siteName;
  }

  return headers;
}

/** N1b: `webSearch()` options as the `parameters` of OpenRouter's `openrouter:web_search` server tool. */
const OPENROUTER_SEARCH_PARAMETERS: HostedOptionMapping = {
  maxUses: (max_uses) => ({ max_uses }),
  allowedDomains: (allowed_domains) => ({ allowed_domains }),
  blockedDomains: (excluded_domains) => ({ excluded_domains }),
  searchContextSize: (search_context_size) => ({ search_context_size }),
  userLocation: undefined,
};

/**
 * What one response left: the web search's count, the cited urls and the
 * completion id (N1b), and the reasoning the model reported (LOU-R8) - the
 * `reasoning` SDK never reaches these fields, so they are read from the
 * response body itself.
 */
interface CallObservation {
  id?: string;
  requests?: number;
  sources: Array<{ url: string; title?: string }>;
  /** Reasoning text fragments and detail end-markers, in arrival order. */
  reasoning: ReasoningPiece[];
  reasoningTokens?: number;
  /** `usage.cost`: the USD OpenRouter billed for the call. */
  costUsd?: number;
}

/** The parts of a response body or stream chunk that a web search or the reasoning leaves. */
interface ResponseBody {
  id?: unknown;
  usage?: {
    server_tool_use?: { web_search_requests?: unknown };
    completion_tokens_details?: { reasoning_tokens?: unknown };
    reasoning_tokens?: unknown;
    cost?: unknown;
  };
  choices?: Array<{
    message?: { annotations?: unknown; reasoning?: unknown; reasoning_details?: unknown };
    delta?: { annotations?: unknown; reasoning?: unknown; reasoning_details?: unknown };
  }>;
}

/** A `url_citation` annotation's source (OpenRouter nests the fields under `url_citation`; a flat one is read too). */
function citedSource(note: Record<string, unknown>): { url: string; title?: string } | undefined {
  if (note.type !== 'url_citation') return undefined;
  const { url, title } = (note.url_citation ?? note) as { url?: unknown; title?: unknown };
  if (typeof url !== 'string') return undefined;
  return { url, ...(typeof title === 'string' && title !== '' && { title }) };
}

/** One piece of observed reasoning: a text fragment, or the signature/encrypted data ending a `reasoning_details` block. */
type ReasoningPiece = { text: string } | { end: Omit<ReasoningBlock, 'text'> };

/** One `reasoning_details` entry (`reasoning.text`/`reasoning.summary`/`reasoning.encrypted`) as pieces. */
function detailPieces(detail: Record<string, unknown>): ReasoningPiece[] {
  const pieces: ReasoningPiece[] = [];
  if (detail.type === 'reasoning.encrypted') {
    // An encrypted entry is its own block: close the text being accumulated, then it.
    if (typeof detail.data === 'string' && detail.data !== '') pieces.push({ end: {} }, { end: { redactedData: detail.data } });
    return pieces;
  }
  const text = detail.type === 'reasoning.summary' ? detail.summary : detail.text;
  if (typeof text === 'string' && text !== '') pieces.push({ text });
  if (typeof detail.signature === 'string' && detail.signature !== '') pieces.push({ end: { signature: detail.signature } });
  return pieces;
}

/** The reasoning of one `message` or `delta`: its `reasoning_details` when sent, else its flat `reasoning` text. */
function reasoningPieces(of: { reasoning?: unknown; reasoning_details?: unknown } | undefined): ReasoningPiece[] {
  if (Array.isArray(of?.reasoning_details) && of.reasoning_details.length > 0) {
    return (of.reasoning_details as Array<Record<string, unknown>>).flatMap(detailPieces);
  }
  return typeof of?.reasoning === 'string' && of.reasoning !== '' ? [{ text: of.reasoning }] : [];
}

/** The `usage` fields one response body or stream chunk adds to `found`. */
function scanUsage(usage: ResponseBody['usage'], found: CallObservation): void {
  const requests = usage?.server_tool_use?.web_search_requests;
  if (typeof requests === 'number') found.requests = Math.max(found.requests ?? 0, requests);
  const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens ?? usage?.reasoning_tokens;
  if (typeof reasoningTokens === 'number') found.reasoningTokens = reasoningTokens;
  const cost = usage?.cost;
  if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) found.costUsd = cost;
}

/** The citations and the reasoning of one `choice` (`message` or `delta`). */
function scanChoice(choice: NonNullable<ResponseBody['choices']>[number], found: CallObservation): void {
  const annotations = choice.message?.annotations ?? choice.delta?.annotations;
  const sources = (Array.isArray(annotations) ? (annotations as Array<Record<string, unknown>>) : []).map(citedSource);
  for (const source of sources) {
    if (source && !found.sources.some((known) => known.url === source.url)) found.sources.push(source);
  }
  found.reasoning.push(...reasoningPieces(choice.message ?? choice.delta));
}

/** `usage.server_tool_use.web_search_requests`, the citations and the reasoning of one response body or stream chunk. */
function scanResponseBody(chunk: ResponseBody | null, found: CallObservation): void {
  if (typeof chunk?.id === 'string') found.id ??= chunk.id;
  scanUsage(chunk?.usage, found);
  for (const choice of chunk?.choices ?? []) scanChoice(choice, found);
}

/** A JSON response body, or a server-sent-events stream of JSON chunks, as a {@link CallObservation}. */
function parseResponseBody(text: string): CallObservation {
  const found: CallObservation = { sources: [], reasoning: [] };
  const lines = text.trimStart().startsWith('{')
    ? [text]
    : text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5));
  for (const line of lines) {
    try {
      scanResponseBody(JSON.parse(line) as ResponseBody, found);
    } catch {
      // `[DONE]` or a partial line carries nothing.
    }
  }
  return found;
}

/** The observed reasoning pieces as {@link ReasoningBlock}s: each `end` marker closes the block being accumulated. */
function reasoningBlocks(found: CallObservation | undefined): ReasoningBlock[] {
  const blocks: ReasoningBlock[] = [];
  let open = '';
  const close = (end: Omit<ReasoningBlock, 'text'>): void => {
    if (open !== '' || end.signature !== undefined || end.redactedData !== undefined) blocks.push({ text: open, ...end });
    open = '';
  };
  for (const piece of found?.reasoning ?? []) {
    if ('text' in piece) open += piece.text;
    else close(piece.end);
  }
  close({});
  return blocks;
}

/** The observed reasoning pieces as the stream chunks reporting them (LOU-R8). */
function reasoningChunks(found: CallObservation | undefined): StreamChunk[] {
  return (found?.reasoning ?? []).map((piece): StreamChunk =>
    'text' in piece ? { type: 'reasoning-delta', textDelta: piece.text } : { type: 'reasoning-end', reasoning: piece.end }
  );
}

/** What one model call changes about the request, and what it watches in the response. */
interface RequestChanges {
  /** Top-level body fields to set (LOU-V13: `reasoning`). */
  merge?: Record<string, unknown>;
  /** N1b: tool entries appended to the body's `tools` array, after the function tools `@ai-sdk/openai` put there. */
  tools?: unknown[];
  /** Called with the parsed response of each successful call (the last one wins). */
  observe?: (settled: Promise<CallObservation | undefined>) => void;
}

/** `fetch`, with each JSON request body changed as `changes` says (the reasoning merge and the tools append compose). */
function withRequestChanges(changes: RequestChanges, send: typeof fetch): typeof fetch {
  return async (input, init) => {
    let body = init?.body;
    if (typeof body === 'string') {
      const json = JSON.parse(body) as Record<string, unknown>;
      const tools = changes.tools && [...(Array.isArray(json.tools) ? (json.tools as unknown[]) : []), ...changes.tools];
      body = JSON.stringify({ ...json, ...changes.merge, ...(tools && { tools }) });
    }
    const response = await send(input, { ...init, body });
    if (changes.observe && response.ok) {
      // The clone is read in the background; the caller reads the original as usual.
      changes.observe(
        response
          .clone()
          .text()
          .then(parseResponseBody, () => undefined)
      );
    }
    return response;
  };
}

/**
 * OpenRouter's error body as the `{error}` object `@ai-sdk/openai`'s error
 * schema expects, or `undefined` when the body has no explanation to keep.
 * OpenRouter sends `{error: {message, code}}` with `code` a NUMBER and no
 * `type`/`param`, which fails that schema - the SDK then reports only the
 * status text.
 */
/** Cap on the upstream body kept under `metadata.raw` of a normalized error. */
const MAX_UPSTREAM_RAW_CHARS = 2000;

/**
 * The upstream provider's own error message inside OpenRouter's
 * `error.metadata.raw` (a JSON string of the upstream body), bounded to
 * {@link MAX_UPSTREAM_RAW_CHARS}.
 */
function upstreamRawMessage(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  let parsed: { error?: { message?: unknown } | string; message?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return undefined;
  }
  const error = parsed?.error;
  const message = typeof error === 'string' ? error : (error?.message ?? parsed?.message);
  if (typeof message !== 'string' || message.trim() === '') return undefined;
  return message.slice(0, MAX_UPSTREAM_RAW_CHARS);
}

function normalizedOpenRouterError(body: string): {
  error: { message: string; type: string; param: unknown; code: string | null; metadata?: { raw: string } };
} | undefined {
  let parsed: { error?: unknown; message?: unknown };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return undefined;
  }
  const error = parsed?.error;
  const fields = (typeof error === 'object' && error !== null ? error : {}) as {
    message?: unknown;
    type?: unknown;
    param?: unknown;
    code?: unknown;
    metadata?: { raw?: unknown };
  };
  const message = typeof error === 'string' ? error : (fields.message ?? parsed?.message);
  if (typeof message !== 'string' || message.trim() === '') return undefined;
  // OpenRouter reports an upstream provider's failure with the generic
  // "Provider returned error" and keeps the real explanation in
  // `error.metadata.raw` - append it (bounded) so the thrown error, and its
  // compacted form, say what actually failed.
  const upstream = upstreamRawMessage(fields.metadata?.raw);
  return {
    error: {
      message: upstream && !message.includes(upstream) ? `${message} (${upstream})` : message,
      type: typeof fields.type === 'string' ? fields.type : 'openrouter_error',
      param: fields.param ?? null,
      code: fields.code == null ? null : String(fields.code),
      // Kept for consumers reading `responseBody` (e.g. compactProviderError
      // digs the upstream message out of it).
      ...(typeof fields.metadata?.raw === 'string' && fields.metadata.raw.trim() !== ''
        ? { metadata: { raw: fields.metadata.raw.slice(0, MAX_UPSTREAM_RAW_CHARS) } }
        : {}),
    },
  };
}

/**
 * LOU-R5: `fetch` that keeps OpenRouter's error explanation. The real cause
 * of a failed call lives in the response body's `error.message` ("No
 * endpoints found for ...", "No auth credentials found"), but the body does
 * not match `@ai-sdk/openai`'s error schema (see normalizedOpenRouterError),
 * so the thrown `APICallError` ends up with `message` of only the bare HTTP
 * status text - "Not Found", or "" when the HTTP/2 response has no reason
 * phrase. Rewriting a non-OK JSON error body into the OpenAI error shape
 * puts the provider's explanation on the thrown error's `message`.
 */
function withErrorMessage(inner: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await inner(input, init);
    if (response.ok) return response;
    // The clone is read so the original body stays intact when there is
    // nothing to normalize.
    const normalized = normalizedOpenRouterError(await response.clone().text());
    if (normalized === undefined) return response;
    return new Response(JSON.stringify(normalized), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/**
 * `usage`, with the observed reasoning token count and the cost OpenRouter
 * billed (`usage.cost`) that the SDK's usage lacks (the same instance when
 * nothing is added).
 */
function withObservedUsage(usage: ProviderUsage | undefined, found: CallObservation | undefined): ProviderUsage | undefined {
  if (!usage || !found) return usage;
  const reasoningTokens = usage.reasoningTokens === undefined ? found.reasoningTokens : undefined;
  const costUsd = usage.costUsd === undefined ? found.costUsd : undefined;
  if (reasoningTokens === undefined && costUsd === undefined) return usage;
  return { ...usage, ...(reasoningTokens !== undefined && { reasoningTokens }), ...(costUsd !== undefined && { costUsd }) };
}

/** The hosted call a step's search left, from what its response reported (undefined when it did not search). */
function searchCallOf(found: CallObservation | undefined): HostedToolCall | undefined {
  if (!found || ((found.requests ?? 0) === 0 && found.sources.length === 0)) return undefined;
  return {
    id: `${found.id ?? 'openrouter'}:web_search`,
    name: 'web_search',
    args: {},
    result: found.requests === undefined ? {} : { requests: found.requests },
    ...(found.sources.length > 0 && { sources: found.sources }),
  };
}

/**
 * OpenRouter Provider using OpenAI-compatible API
 */
export class OpenRouterProvider extends AiSdkProvider<OpenRouterProviderConfig> {
  readonly name = 'openrouter';
  protected readonly fallbackModel = 'openai/gpt-4o-mini';
  private logger: Logger;

  /** Loads `@ai-sdk/openai` on first use (it is an optional peer). */
  private readonly loadFactory = lazyValue(async () =>
    (await loadOptionalPeer('@ai-sdk/openai', () => import('@ai-sdk/openai'), aiMajorOf(this.ai))).createOpenAI
  );

  /** `@ai-sdk/openai` pointed at OpenRouter; `changes` (LOU-V13 `reasoning`, N1b web search) are applied to each request. */
  private async openRouter(changes?: RequestChanges) {
    // LOU-R5: every call goes through the fetch that keeps the body's error
    // message; the request `changes` compose inside it. `globalThis.fetch` is
    // read per call so tests can stub it after the provider was created; a
    // configured `fetch` (C2) is used instead.
    const base: typeof fetch = (input, init) => (this.config.fetch ?? globalThis.fetch)(input, init);
    const inner: typeof fetch = changes ? withRequestChanges(changes, base) : base;
    return (await this.loadFactory())({
      apiKey: this.config.apiKey,
      baseURL: OPENROUTER_API_URL,
      headers: buildHeaders(this.config),
      fetch: withErrorMessage(inner),
    });
  }

  /** What each call (by its options object) left in OpenRouter's response: the web search (N1b) and the reasoning (LOU-R8). */
  private readonly observed = new WeakMap<GenerateOptions, { settled?: Promise<CallObservation | undefined> }>();

  private readonly loadProvider = lazyValue(() => this.openRouter());

  constructor(config: OpenRouterProviderConfig, logger: Logger = noopLogger) {
    super(config);
    this.logger = logger;
  }

  /** PDF file parts go to the model on ai 6 and 7; older peers have no file parts. */
  protected fileMediaTypes(): readonly string[] {
    return aiMajorOf(this.ai) >= 6 ? ['application/pdf'] : [];
  }

  protected async createModel(modelId: string, options?: GenerateOptions): Promise<LanguageModel> {
    // LOU-V13: `@ai-sdk/openai` has no field for OpenRouter's unified `reasoning`, so it is added to the body.
    const reasoning = openRouterReasoning(modelId, options?.reasoning);
    // N1b: OpenRouter's web search is a server tool in the `tools` array, not an AI SDK tool.
    const search = options?.hostedTools?.find((tool) => tool.type === 'web_search');
    const changes: RequestChanges = { ...(reasoning && { merge: reasoning }) };
    if (search) {
      const parameters = mappedHostedOptions('OpenRouter', search, OPENROUTER_SEARCH_PARAMETERS);
      changes.tools = [{ type: 'openrouter:web_search', ...(Object.keys(parameters).length > 0 && { parameters }) }];
    }
    if (options) {
      // The response is watched for what `@ai-sdk/openai` drops: the reasoning
      // fields (LOU-R8), the server-side search's traces (N1b) and the cost
      // OpenRouter billed (PROV-F3).
      const watch: { settled?: Promise<CallObservation | undefined> } = {};
      this.observed.set(options, watch);
      changes.observe = (settled) => {
        watch.settled = settled;
      };
    }
    if (options || changes.merge || changes.tools) return (await this.openRouter(changes)).chat(modelId);
    // `.chat()` is the Chat Completions API, the only one OpenRouter implements. `@ai-sdk/openai`
    // 2+ makes the bare call a Responses API model, so the factory is named on every major.
    return (await this.loadProvider()).chat(modelId);
  }

  /**
   * N1b: `webSearch()` only (an `openrouter:web_search` server tool added to the request body); `hostedTool()`
   * passes through on ai 6 or 7. The server runs the search inside the request, so the model reports no tool call:
   * the call is read from the response (see generate() and stream()).
   */
  supportsHostedTool(type: HostedToolType | 'custom'): boolean {
    return type === 'web_search' || super.supportsHostedTool(type);
  }

  protected async hostedToolsFor(tools: readonly HostedTool[], modelId: string): Promise<Record<string, unknown>> {
    const unsupported = tools.find((tool) => tool.type === 'code_interpreter' || tool.type === 'file_search');
    if (unsupported) throw hostedToolUnsupported(this.name, unsupported, 'OpenRouter runs only web search (webSearch())');
    return super.hostedToolsFor(
      tools.filter((tool) => tool.type === 'custom'),
      modelId
    );
  }

  /** What the call made with `options` left in its response (the search's traces and the reasoning), once it was read. */
  private async observation(options: GenerateOptions): Promise<CallObservation | undefined> {
    return this.observed.get(options)?.settled;
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const result = await super.generate(options);
    const found = await this.observation(options);
    if (!found) return result;
    const call = searchCallOf(found);
    const reasoning = reasoningBlocks(found);
    const usage = withObservedUsage(result.usage, found);
    return {
      ...result,
      ...(usage && { usage }),
      ...(call && { hostedToolCalls: [...(result.hostedToolCalls ?? []), call] }),
      // The SDK-reported reasoning, when any, stays (LOU-R8's observed blocks win: they carry the details it dropped).
      ...(reasoning.length > 0 && { reasoning }),
    };
  }

  async stream(options: GenerateOptions): Promise<StreamResult> {
    const result = await super.stream(options);
    if (!this.observed.has(options)) return result;
    const usage = this.usageWithReasoning(result.usage, options);
    usage.catch(() => undefined); // Marked handled, as streamCompat marks the original's.
    return { ...result, usage, fullStream: this.withObservation(result.fullStream, options) };
  }

  /** `usage`, with the observed reasoning token count when the SDK's stream did not carry it. */
  private async usageWithReasoning(usage: Promise<ProviderUsage | undefined>, options: GenerateOptions): Promise<ProviderUsage | undefined> {
    return withObservedUsage(await usage, await this.observation(options));
  }

  /**
   * `chunks`, with what the response left that the SDK dropped, just before the
   * `finish` chunk (the response is read to its end by then): the reasoning
   * chunks (LOU-R8) and the web search's hosted call (N1b); the `finish` chunk's
   * usage gains the reasoning token count it lacks.
   */
  private async *withObservation(chunks: AsyncIterable<StreamChunk>, options: GenerateOptions): AsyncGenerator<StreamChunk> {
    let flushed = false;
    // A newer `@ai-sdk/openai` may report reasoning itself; the observed chunks only fill what it dropped.
    let sdkReasoning = false;
    for await (const chunk of chunks) {
      if (chunk.type === 'reasoning-delta' || chunk.type === 'reasoning-end') sdkReasoning = true;
      if (chunk.type !== 'finish' || flushed) {
        yield chunk;
        continue;
      }
      flushed = true;
      const found = await this.observation(options);
      if (!sdkReasoning) yield* reasoningChunks(found);
      const call = searchCallOf(found);
      if (call) {
        yield { type: 'hosted-tool-call', hostedToolCall: { id: call.id, name: call.name, args: call.args } };
        yield { type: 'hosted-tool-result', hostedToolCall: call };
      }
      yield chunk.usage ? { ...chunk, usage: withObservedUsage(chunk.usage, found) } : chunk;
    }
    if (!flushed && !sdkReasoning) yield* reasoningChunks(await this.observation(options));
  }

  /** Sent in the request body instead (createModel). */
  protected reasoningOptions(): undefined {
    return undefined;
  }

  /**
   * Check if model supports tools
   * Most OpenRouter models support tools, especially OpenAI and Anthropic models
   */
  supportsTools(model: string): boolean {
    // OpenAI models
    if (model.includes('gpt-4') || model.includes('gpt-3.5-turbo')) {
      return true;
    }

    // Anthropic models
    if (model.includes('claude')) {
      return true;
    }

    // Google models
    if (model.includes('gemini')) {
      return true;
    }

    // Mistral models
    if (model.includes('mistral')) {
      return true;
    }

    // Default to true for most models
    return true;
  }

  /**
   * Check if model supports streaming
   */
  supportsStreaming(_model: string): boolean {
    return true; // All OpenRouter models support streaming
  }

  /**
   * Fetch OpenRouter's model catalog. Throws `Failed to fetch <what>: ...` on
   * a non-OK response so callers can log and fall back.
   */
  private async fetchModelCatalog(what: string): Promise<OpenRouterModel[] | undefined> {
    const response = await fetch(`${OPENROUTER_API_URL}/models`, {
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
    });

    if (!response.ok) {
      // Callers catch this, log it and fall back; the message stays as it was.
      throw new SDKError(`Failed to fetch ${what}: ${response.statusText}`, 'LOUSHO_PROVIDER_REQUEST_FAILED', { appendHelp: false });
    }

    const data = await response.json();
    return data.data;
  }

  /**
   * Get available models from OpenRouter
   */
  async getModels(): Promise<string[]> {
    try {
      const models = await this.fetchModelCatalog('models');
      return models?.map((model) => model.id) || [];
    } catch (error) {
      this.logger.warn('Failed to fetch OpenRouter models', { error: (error as Error).message });

      // Return some popular models as fallback
      return [
        'openai/gpt-4o',
        'openai/gpt-4o-mini',
        'openai/gpt-4-turbo',
        'openai/gpt-3.5-turbo',
        'anthropic/claude-3.5-sonnet',
        'anthropic/claude-3-opus',
        'anthropic/claude-3-haiku',
        'google/gemini-pro',
        'google/gemini-pro-1.5',
        'meta-llama/llama-3.1-70b-instruct',
        'meta-llama/llama-3.1-8b-instruct',
        'mistralai/mistral-large',
        'mistralai/mixtral-8x7b-instruct',
      ];
    }
  }

  /**
   * Get model information including pricing
   */
  async getModelInfo(modelId: string): Promise<OpenRouterModel | null | undefined> {
    try {
      const models = await this.fetchModelCatalog('model info');
      return models?.find((model) => model.id === modelId);
    } catch (error) {
      this.logger.warn('Failed to fetch model info', { error: (error as Error).message });
      return null;
    }
  }
}
