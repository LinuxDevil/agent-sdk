/**
 * M2: any AI SDK `LanguageModel` (Google, Bedrock, Azure, Mistral, the
 * Gateway, ...) as an `LLMProvider`, through the same adapter the built-in
 * providers use (`AiSdkProvider`, which stays internal).
 *
 * This module imports no provider package: the caller built the model, and
 * calls go through the installed `ai`.
 */

import * as aiModule from 'ai';
import type { LanguageModel } from 'ai';
import { ConfigurationError } from '../execution/errors';
import type { GenerateOptions, LLMProvider } from './llm';
import { AiSdkProvider, type AiSdkProviderConfig } from './aiSdkProvider';
import { aiMajorOf, type AiSdkModule } from './aiSdkCompat';

/** Options of {@link fromAiSdk}. */
export interface FromAiSdkOptions {
  /** Provider name used in events, spans and warnings. Default: the model's `provider` field (e.g. 'google.generative-ai'), else 'ai-sdk'. */
  name?: string;
  /** Media types sent as file parts (e.g. `['application/pdf']`). Default: [] (file parts become a text note). Image parts are always sent. */
  fileMediaTypes?: readonly string[];
  /** Send signed reasoning blocks back on assistant turns (Anthropic models). Default false. */
  replaysReasoning?: boolean;
  /** The AI SDK's own retries per call. Default 0: createAgent() retries through `retry`. */
  maxRetries?: number;
}

/** The fields read from a model of any `ai` major (their types differ per major). */
interface ModelFields {
  specificationVersion?: unknown;
  provider?: unknown;
  modelId?: unknown;
}

/** A string field of the model, or `undefined`. */
function field(model: ModelFields, key: keyof ModelFields): string | undefined {
  const value = model[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Throws unless `model` is a language model object that the installed `ai` major can call. */
function checkModel(model: unknown, ai: AiSdkModule): asserts model is ModelFields {
  if (typeof model === 'string') {
    throw new ConfigurationError(
      `fromAiSdk() takes a language model object, not the model id string '${model}'. ` +
        `Import the provider function and pass its model, e.g. google('gemini-2.0-flash'); ` +
        `for the AI Gateway: gateway('${model}') from ai 7 or @ai-sdk/gateway.`,
      'model'
    );
  }
  if (typeof model !== 'object' || model === null) {
    throw new ConfigurationError(`fromAiSdk() takes an AI SDK language model object; got ${model === null ? 'null' : typeof model}.`, 'model');
  }
  const version = field(model as ModelFields, 'specificationVersion') ?? 'unknown';
  const major = aiMajorOf(ai);
  if (major === 4 && version !== 'v1') {
    throw new ConfigurationError(
      `fromAiSdk(): this model is an AI SDK v5+ model (specificationVersion ${version}) but ai 4 is installed; ` +
        'install the provider package version that pairs with ai 4, or upgrade ai.',
      'model'
    );
  }
  if (major !== 4 && version === 'v1') {
    throw new ConfigurationError(
      `fromAiSdk(): this model is an AI SDK v4-era model (specificationVersion v1) but ai ${major} is installed; ` +
        `install the provider package for ai ${major}.`,
      'model'
    );
  }
}

/** The adapter: one wrapped model, every capability on (the caller chose the model). */
class FromAiSdkProvider extends AiSdkProvider<AiSdkProviderConfig> {
  readonly name: string;
  protected readonly fallbackModel: string;
  protected declare readonly ai: AiSdkModule;
  protected declare readonly replaysReasoning: boolean;
  private readonly model: LanguageModel;
  private readonly sendable: readonly string[];

  constructor(model: LanguageModel, options: FromAiSdkOptions, ai: AiSdkModule) {
    checkModel(model, ai);
    const modelId = field(model, 'modelId') ?? 'ai-sdk-model';
    const name = options.name ?? field(model, 'provider') ?? 'ai-sdk';
    super({ name, defaultModel: modelId, maxRetries: options.maxRetries ?? 0 });
    this.ai = ai;
    this.name = name;
    this.fallbackModel = modelId;
    this.model = model;
    this.replaysReasoning = options.replaysReasoning ?? false;
    this.sendable = (options.fileMediaTypes ?? []).map((type) => type.trim().toLowerCase());
  }

  protected createModel(modelId: string): LanguageModel {
    if (modelId !== this.defaultModel) {
      throw new ConfigurationError(
        `fromAiSdk() wraps one model (${this.defaultModel}); wrap another model with fromAiSdk() and use withFallback() instead of model: '${modelId}'.`,
        'model'
      );
    }
    return this.model;
  }

  protected fileMediaTypes(): readonly string[] {
    return this.sendable;
  }

  /** The caller configured the model; the built-in providers' reasoning mapping does not apply to an unknown provider. */
  protected reasoningOptions(_modelId: string, _options: GenerateOptions): undefined {
    return undefined;
  }

  supportsTools(): boolean {
    return true;
  }

  supportsStreaming(): boolean {
    return true;
  }

  async getModels(): Promise<string[]> {
    return [this.defaultModel];
  }
}

/**
 * Internal: `fromAiSdk()` against a given `ai` module, so tests can check a
 * model against the aliased `ai` v7. Not exported from the package.
 */
export function createFromAiSdk(model: LanguageModel, options: FromAiSdkOptions, ai: AiSdkModule): LLMProvider {
  return new FromAiSdkProvider(model, options, ai);
}

/**
 * Any AI SDK `LanguageModel` as an `LLMProvider`, for `createAgent({ provider })`.
 * The provider serves only this model: a run that names another model id
 * throws `LOUSHO_CONFIG_INVALID` (wrap each model and use `withFallback()`).
 *
 * Throws `LOUSHO_CONFIG_INVALID` for a model id string (import the provider
 * function instead) and for a model built for another `ai` major than the
 * installed one.
 *
 * @example
 * ```ts
 * import { google } from '@ai-sdk/google';
 * const agent = createAgent({ provider: fromAiSdk(google('gemini-2.0-flash')) });
 * ```
 */
export function fromAiSdk(model: LanguageModel, options: FromAiSdkOptions = {}): LLMProvider {
  return createFromAiSdk(model, options, aiModule);
}
