/**
 * `pi` provider (H2): a native `LLMProvider` over `@earendil-works/pi-ai`
 * (the same engine `pi-coding-agent` runs on). The model spec carries the
 * nested pi provider: `pi/<pi-provider>/<model>` - e.g.
 * `pi/openrouter/openai/gpt-4o-mini` for OpenRouter's `openai/gpt-4o-mini`.
 *
 * pi is an optional peer (LOU-D10/LOU-D19): nothing here imports it at
 * module scope; `piModules()` loads the `compat` entrypoint and the
 * generated catalog on the first call, and a missing package becomes a
 * `LOUSHO_PEER_MISSING` `MissingPeerDependencyError` with the install
 * command. The provider is Node-only for now: the Worker build redirects
 * the pi specifiers to `deploy/shims/pi.worker.ts`, and `pi` is not in
 * `WORKER_SUPPORTED_PROVIDERS`.
 *
 * Retries are Lousho's alone (`withRetry()`/`withFallback()` wrap this
 * provider like every other): pi's own `maxRetries` is pinned off, matching
 * the `maxRetries: 0` the ai-SDK providers get from `resolveProviderSpec()`.
 */

import type {
  GenerateOptions,
  GenerateResult,
  LLMProvider,
  LLMProviderConfig,
  ProviderUsage,
  StreamChunk,
  StreamResult,
  ToolCall,
  ToolDefinition,
} from '../llm';
import type { ReasoningOption } from '../reasoning';
import { ConfigurationError, LLMProviderError, SDKError } from '../../execution/errors';
import { hostedToolUnsupported } from '../../tools/hosted';
import { closestMatch } from '../../utils/closestMatch';
import { lazyValue, loadOptionalPeer } from '../optionalPeer';
import { registerModel } from '../../models/registry';
import { toPiContext } from './messages';
import { toolParametersToJsonSchema } from './schema';
import type {
  PiAssistantMessage,
  PiCatalogModule,
  PiCompatModule,
  PiEventStream,
  PiModel,
  PiStreamEvent,
  PiStreamOptions,
  PiStopReason,
  PiThinkingContent,
  PiTool,
  PiToolCallContent,
} from './piTypes';

const PACKAGE = '@earendil-works/pi-ai';

/** pi catalog model ids the provider was built with, in addition to the builtin catalog (faux test providers, custom registrations). */
export interface PiProviderConfig extends LLMProviderConfig {
  models?: readonly PiModel[];
}

/** The fallback nested spec when the constructor got no `defaultModel`. */
const FALLBACK_MODEL = 'openrouter/openai/gpt-4o-mini';

/**
 * Env var names used in missing-key error text. pi resolves each nested
 * provider's credential itself (`compat.getEnvApiKey`, which knows every
 * provider's candidate vars); it only does not publish the var NAMES, so
 * the message keeps a small map for the providers worth naming (the live
 * path is openrouter -> OPENROUTER_API_KEY).
 */
const NESTED_ENV_NAMES: Record<string, string> = { openrouter: 'OPENROUTER_API_KEY' };

/** The two lazy pi imports, loaded once (and re-attempted after a failure). */
const piModules = lazyValue(async (): Promise<{ compat: PiCompatModule; catalog: PiCatalogModule }> => {
  const [compat, catalog] = await Promise.all([
    loadOptionalPeer(PACKAGE, () => import('@earendil-works/pi-ai/compat') as Promise<unknown>),
    loadOptionalPeer(PACKAGE, () => import('@earendil-works/pi-ai/providers/all') as Promise<unknown>),
  ]);
  return { compat: compat as PiCompatModule, catalog: catalog as PiCatalogModule };
});

/** pi `stopReason` -> our finishReason; `pending`/`deferred` are unreachable in a completed call. */
function mapStopReason(reason: PiStopReason | undefined): GenerateResult['finishReason'] {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'toolUse':
      return 'tool_calls';
    default:
      return 'error';
  }
}

/**
 * The finish reason a completed assistant message maps to. A message that
 * still asks for tool calls but reported 'stop' (the faux provider's
 * default) is treated as 'tool_calls' so the executor runs them.
 */
function finishReasonOf(message: PiAssistantMessage): GenerateResult['finishReason'] {
  const reason = mapStopReason(message.stopReason);
  return reason === 'stop' && message.content.some((part) => part.type === 'toolCall') ? 'tool_calls' : reason;
}

/** pi `Usage` -> our provider-facing usage; `costUsd` keeps pi's own total (catalog-priced). */
function piUsage(usage: PiAssistantMessage['usage'] | undefined): ProviderUsage | undefined {
  if (!usage || typeof usage.input !== 'number' || typeof usage.output !== 'number') return undefined;
  return {
    promptTokens: usage.input,
    completionTokens: usage.output,
    totalTokens: typeof usage.totalTokens === 'number' ? usage.totalTokens : usage.input + usage.output,
    ...(usage.cacheRead > 0 ? { cachedInputTokens: usage.cacheRead } : {}),
    ...(typeof usage.reasoning === 'number' ? { reasoningTokens: usage.reasoning } : {}),
    ...(usage.cost && typeof usage.cost.total === 'number' && usage.cost.total > 0 ? { costUsd: usage.cost.total } : {}), // 0 = pi priced nothing: the registry's catalog price applies
  };
}

function assistantText(message: PiAssistantMessage): string {
  let text = '';
  for (const part of message.content) if (part.type === 'text') text += part.text;
  return text;
}

function assistantToolCalls(message: PiAssistantMessage): ToolCall[] {
  return message.content
    .filter((part): part is PiToolCallContent => part.type === 'toolCall')
    .map((call) => ({
      id: call.id,
      type: 'function' as const,
      function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
    }));
}

function assistantReasoning(message: PiAssistantMessage): GenerateResult['reasoning'] {
  const blocks = message.content
    .filter((part): part is PiThinkingContent => part.type === 'thinking')
    .map((block) =>
      block.redacted
        ? { text: '', redactedData: block.thinkingSignature ?? '' }
        : { text: block.thinking, ...(block.thinkingSignature !== undefined && { signature: block.thinkingSignature }) }
    );
  return blocks.length > 0 ? blocks : undefined;
}

/**
 * pi `reasoning`/`reasoningEffort` for our `reasoning` option (LOU-V13):
 * `effort` is already a pi thinking level; `budgetTokens` becomes the level's
 * `thinkingBudgets` entry. Sent only to models the catalog marks
 * `reasoning`, unless `force` - the same gate every built-in provider uses.
 */
function reasoningOptions(model: PiModel, option: ReasoningOption | undefined): Partial<PiStreamOptions> {
  if (option === undefined) return {};
  const settings = typeof option === 'string' ? { effort: option } : option;
  const effort = settings.effort ?? 'medium';
  if (effort === 'none' || (!settings.force && !model.reasoning)) return {};
  return {
    reasoning: effort,
    ...(settings.budgetTokens !== undefined && { thinkingBudgets: { [effort]: settings.budgetTokens } }),
  };
}

/** `samplingParams` for the request fields pi has no named option for (openai-compatible apis only). */
function samplingParams(options: GenerateOptions): Record<string, unknown> | undefined {
  const params: Record<string, unknown> = {};
  if (options.topP !== undefined) params.top_p = options.topP;
  if (options.frequencyPenalty !== undefined) params.frequency_penalty = options.frequencyPenalty;
  if (options.presencePenalty !== undefined) params.presence_penalty = options.presencePenalty;
  if (options.seed !== undefined) params.seed = options.seed;
  if (options.stop !== undefined) params.stop = options.stop;
  if (options.responseFormat?.type === 'json') {
    params.response_format = options.responseFormat.schema
      ? { type: 'json_schema', json_schema: { name: 'output', strict: true, schema: options.responseFormat.schema } }
      : { type: 'json_object' };
  }
  // pi's neutral ToolChoice is only 'auto'|'none'; a 'required'/named choice
  // is the openai `tool_choice` request field, which samplingParams reaches.
  const choice = options.toolChoice;
  if (choice !== undefined && choice !== 'auto' && choice !== 'none') params.tool_choice = choice;
  return Object.keys(params).length > 0 ? params : undefined;
}

/** The `error` chunk's Error, for pi's error end-state. */
function streamError(message: PiAssistantMessage | undefined, providerName: string): Error {
  const text = message?.errorMessage || 'The pi model call failed';
  return new LLMProviderError(text, providerName);
}

/** A `fullStream` consumer's text deltas. */
async function* textDeltas(chunks: AsyncIterable<StreamChunk>): AsyncGenerator<string> {
  for await (const chunk of chunks) if (chunk.type === 'text-delta' && chunk.textDelta) yield chunk.textDelta;
}

/** `promise`, marked handled: a final value nobody reads must not become an unhandled rejection when the stream fails. */
function handled<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

/**
 * A `LLMProvider` backed by `@earendil-works/pi-ai`. Mostly used through the
 * `pi/` spec prefix - `createAgent({ model: 'pi/openrouter/openai/gpt-4o-mini' })`
 * - but it can be constructed directly, e.g. to inject a custom or faux
 * catalog (`models`).
 */
export class PiProvider implements LLMProvider {
  readonly name = 'pi';
  protected config: PiProviderConfig;

  constructor(config: PiProviderConfig = {}) {
    this.config = config;
  }

  /** The configured `defaultModel` (a nested `<pi-provider>/<model>` spec), else the OpenRouter default. */
  get defaultModel(): string {
    return this.config.defaultModel || FALLBACK_MODEL;
  }

  /**
   * The nested spec `pi/<provider>/<model>` accepts in `defaultModel` and
   * `GenerateOptions.model`: a `pi/` prefix is tolerated (the whole spec),
   * then the FIRST slash splits provider from model id, so model ids that
   * themselves contain slashes (`openrouter/openai/gpt-4o-mini`) work.
   */
  private nestedSpec(spec: string): { provider: string; modelId: string } {
    const nested = spec.startsWith('pi/') ? spec.slice(3) : spec;
    const slash = nested.indexOf('/');
    if (slash <= 0 || slash === nested.length - 1) {
      throw new ConfigurationError(
        `The 'pi' provider expected a 'pi/<pi-provider>/<model>' spec such as 'pi/openrouter/openai/gpt-4o-mini', got '${spec}'.`,
        'model',
        'LOUSHO_PROVIDER_SPEC_INVALID'
      );
    }
    return { provider: nested.slice(0, slash), modelId: nested.slice(slash + 1) };
  }

  /**
   * Resolve the nested spec to a catalog model: `config.models` first (the
   * faux/custom registrations), then pi's builtin catalog. The found
   * model's catalog pricing is registered under the ids `measureUsage()`
   * sees (`<provider>/<id>` and `pi/<provider>/<id>`), so a run's
   * `usage.costUsd` is priced without changing `estimateCost()`.
   *
   * Missing-key check: `config.apiKey` is an explicit override (providerSpec
   * does not inject env vars into pi specs - OPENROUTER_API_KEY would leak
   * to other nested providers), and `compat.getEnvApiKey(provider)` runs
   * pi's own per-provider env resolution. When neither supplies a key and
   * the provider's env var is one we can name, resolution fails with the
   * standard LOUSHO_PROVIDER_MISSING_API_KEY; other nested providers let pi
   * report auth failures at call time (faux providers need no key).
   */
  private async resolveModel(compat: PiCompatModule, catalog: PiCatalogModule, spec: string): Promise<PiModel> {
    const { provider, modelId } = this.nestedSpec(spec);
    const injected = this.config.models?.find((candidate) => candidate.provider === provider && candidate.id === modelId);
    const model = injected ?? catalog.getBuiltinModel(provider, modelId);
    if (!model) {
      const known = catalog.getBuiltinProviders();
      if (!known.includes(provider) && !this.config.models?.some((candidate) => candidate.provider === provider)) {
        const suggestion = closestMatch(provider, known);
        throw new ConfigurationError(
          `The 'pi' provider does not know pi provider '${provider}' (spec '${spec}'). ` +
            `Known pi providers: ${known.join(', ')}.` +
            (suggestion ? ` Did you mean 'pi/${suggestion}/${modelId}'?` : ''),
          'model',
          'LOUSHO_PROVIDER_UNKNOWN'
        );
      }
      const ids = [...catalog.getBuiltinModels(provider).map((candidate) => candidate.id), ...(this.config.models ?? []).filter((c) => c.provider === provider).map((c) => c.id)];
      const suggestion = closestMatch(modelId, ids);
      throw new ConfigurationError(
        `The 'pi' provider has no model '${modelId}' under pi provider '${provider}' (spec '${spec}').` +
          (suggestion ? ` Did you mean 'pi/${provider}/${suggestion}'?` : ''),
        'model',
        'LOUSHO_PROVIDER_UNKNOWN'
      );
    }
    const envKey = NESTED_ENV_NAMES[provider];
    if (envKey && this.config.apiKey === undefined && !compat.getEnvApiKey(provider)) {
      throw new ConfigurationError(
        `The 'pi' provider for '${spec}' needs ${envKey}. Set it in your environment, or pass a provider instance: createAgent({ provider: ... })`,
        envKey,
        'LOUSHO_PROVIDER_MISSING_API_KEY'
      );
    }
    const pricing = { contextWindow: model.contextWindow, maxOutputTokens: model.maxTokens, inputCostPerMTok: model.cost?.input, outputCostPerMTok: model.cost?.output };
    registerModel({ id: `pi/${provider}/${modelId}`, provider: 'pi', ...pricing });
    registerModel({ id: `${provider}/${modelId}`, provider: 'pi', ...pricing });
    return model;
  }

  /** pi `Tool`s for our tool definitions (JSON Schema, converted once and cached). */
  private convertTools(toolDefs: ToolDefinition[] | undefined): PiTool[] | undefined {
    if (!toolDefs?.length) return undefined;
    return toolDefs.map((toolDef) => ({
      name: toolDef.function.name,
      description: toolDef.function.description,
      parameters: toolParametersToJsonSchema(toolDef.function.parameters) ?? { type: 'object' },
    }));
  }

  /** The request options shared by generate() and stream(). */
  private callOptions(model: PiModel, options: GenerateOptions): PiStreamOptions {
    return {
      ...(this.config.apiKey !== undefined && { apiKey: this.config.apiKey }),
      ...(this.config.headers && { headers: this.config.headers }),
      signal: options.signal,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      timeoutMs: this.config.timeout,
      // pi's own retries stay off: withRetry() is the only retry layer.
      maxRetries: this.config.maxRetries ?? 0,
      ...(options.toolChoice === 'auto' || options.toolChoice === 'none' ? { toolChoice: options.toolChoice } : {}),
      ...reasoningOptions(model, options.reasoning),
      samplingParams: samplingParams(options),
    };
  }

  /** Reject the hosted tools pi cannot run, before any request is made. */
  private assertNoHostedTools(options: GenerateOptions): void {
    const tool = options.hostedTools?.[0];
    if (tool) throw hostedToolUnsupported(this.name, tool, "the 'pi' provider runs no hosted tools");
  }

  /** The GenerateResult a finished assistant message maps to. */
  private resultOf(message: PiAssistantMessage, options: GenerateOptions): GenerateResult {
    if (message.stopReason === 'aborted') {
      const reason = options.signal?.reason;
      throw reason instanceof Error ? reason : Object.assign(new Error('The pi model call was aborted'), { name: 'AbortError' });
    }
    if (message.stopReason === 'error') {
      throw new LLMProviderError(message.errorMessage || 'The pi model call failed', this.name);
    }
    const toolCalls = assistantToolCalls(message);
    const reasoning = assistantReasoning(message);
    return {
      text: assistantText(message),
      finishReason: finishReasonOf(message),
      usage: piUsage(message.usage),
      ...(toolCalls.length > 0 && { toolCalls }),
      ...(reasoning && { reasoning }),
      rawResponse: message,
    };
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    this.assertNoHostedTools(options);
    const { compat, catalog } = await piModules();
    const model = await this.resolveModel(compat, catalog, options.model || this.defaultModel);
    const context = { ...toPiContext(options.messages, model), tools: this.convertTools(options.tools) };
    // completeSimple may throw synchronously (missing request auth), so the
    // call itself is inside the promise chain for the same wrap.
    const message = await Promise.resolve()
      .then(() => compat.completeSimple(model, context, this.callOptions(model, options)))
      .catch((error: unknown) => {
        if (error instanceof SDKError) throw error;
        throw new LLMProviderError(error instanceof Error ? error.message : String(error), this.name, undefined, error instanceof Error ? error : undefined);
      });
    return this.resultOf(message, options);
  }

  async stream(options: GenerateOptions): Promise<StreamResult> {
    this.assertNoHostedTools(options);
    const { compat, catalog } = await piModules();
    const model = await this.resolveModel(compat, catalog, options.model || this.defaultModel);
    const context = { ...toPiContext(options.messages, model), tools: this.convertTools(options.tools) };
    let events: PiEventStream;
    try {
      events = compat.streamSimple(model, context, this.callOptions(model, options));
    } catch (error) {
      if (error instanceof SDKError) throw error;
      throw new LLMProviderError(error instanceof Error ? error.message : String(error), this.name, undefined, error instanceof Error ? error : undefined);
    }
    const result = events.result();
    const chunks = this.teeChunks(events);

    return {
      textStream: textDeltas(chunks()),
      fullStream: chunks(),
      text: handled(result.then(assistantText)),
      usage: handled(result.then((message) => piUsage(message.usage))),
      finishReason: handled(result.then(finishReasonOf)),
      toolCalls: handled(result.then(assistantToolCalls)),
    };
  }

  /**
   * `textStream` and `fullStream` each read their own chunk iterable (the
   * 'ai' providers' convention): pi's event queue is a single consumer, so
   * the mapped chunks are broadcast to however many iterables ask.
   */
  private teeChunks(events: PiEventStream): () => AsyncGenerator<StreamChunk> {
    const source = this.chunkStream(events);
    const buffered: StreamChunk[] = [];
    let done = false;
    const pull = async (): Promise<boolean> => {
      if (done) return true;
      const next = await source.next();
      if (next.done) done = true;
      else buffered.push(next.value);
      return done;
    };
    return async function* (): AsyncGenerator<StreamChunk> {
      let index = 0;
      for (;;) {
        if (index < buffered.length) {
          yield buffered[index++];
        } else if (await pull()) {
          return;
        }
      }
    };
  }

  /** `thinking_end`: the signature/redaction of the thinking block that closed. */
  private thinkingEndChunk(event: PiStreamEvent): StreamChunk {
    const block = event.partial?.content?.[event.contentIndex ?? -1];
    const thinking = block?.type === 'thinking' ? (block as PiThinkingContent) : undefined;
    const reasoning =
      thinking?.redacted === true
        ? { redactedData: thinking.thinkingSignature ?? '' }
        : thinking?.thinkingSignature !== undefined
          ? { signature: thinking.thinkingSignature }
          : undefined;
    return { type: 'reasoning-end', ...(reasoning && { reasoning }) };
  }

  /** `toolcall_end`: the finished pi tool call as our function-call chunk. */
  private toolCallChunk(event: PiStreamEvent): StreamChunk | undefined {
    if (!event.toolCall) return undefined;
    return {
      type: 'tool-call',
      toolCall: {
        id: event.toolCall.id,
        type: 'function',
        function: { name: event.toolCall.name, arguments: JSON.stringify(event.toolCall.arguments ?? {}) },
      },
    };
  }

  /** `error`: aborts surface as AbortError so callers treat them like a cancelled stream. */
  private errorChunk(event: PiStreamEvent): StreamChunk {
    if (event.reason === 'aborted') {
      return { type: 'error', error: Object.assign(new Error('The pi model call was aborted'), { name: 'AbortError' }) };
    }
    return { type: 'error', error: streamError(event.error ?? event.message, this.name) };
  }

  /** One pi event as the `StreamChunk` it maps to (undefined: no chunk for it). */
  private chunkFor(event: PiStreamEvent): StreamChunk | undefined {
    switch (event.type) {
      case 'text_delta':
        return { type: 'text-delta', textDelta: event.delta ?? '' };
      case 'thinking_delta':
        return { type: 'reasoning-delta', textDelta: event.delta ?? '' };
      case 'thinking_end':
        return this.thinkingEndChunk(event);
      case 'toolcall_end':
        return this.toolCallChunk(event);
      case 'done':
        return { type: 'finish', finishReason: event.message ? finishReasonOf(event.message) : 'stop', ...(event.message?.usage && { usage: piUsage(event.message.usage) }) };
      case 'error':
        return this.errorChunk(event);
      default:
        return undefined; // start / *_start / *_end for text, toolcall_delta: no Lousho chunk
    }
  }

  /** pi's event stream as our `StreamChunk`s. */
  private async *chunkStream(events: PiEventStream): AsyncGenerator<StreamChunk> {
    for await (const event of events) {
      const chunk = this.chunkFor(event);
      if (chunk !== undefined) yield chunk;
    }
  }

  supportsTools(_model: string): boolean {
    return true;
  }

  supportsStreaming(_model: string): boolean {
    return true;
  }

  /** `<pi-provider>/<model>` for every injected and builtin catalog model. */
  async getModels(): Promise<string[]> {
    const { catalog } = await piModules();
    const models: string[] = (this.config.models ?? []).map((model) => `${model.provider}/${model.id}`);
    for (const provider of catalog.getBuiltinProviders()) {
      for (const model of catalog.getBuiltinModels(provider)) models.push(`${provider}/${model.id}`);
    }
    return models;
  }
}
