/**
 * OpenRouter Provider Implementation
 * Uses OpenAI-compatible API through the 'ai' SDK (shared logic in ./aiSdkProvider)
 */

import { LanguageModel } from 'ai';
import { AiSdkProvider, AiSdkProviderConfig } from './aiSdkProvider';
import { aiMajorOf } from './aiSdkCompat';
import { lazyValue, loadOptionalPeer } from './optionalPeer';
import { Logger, noopLogger } from '../execution/logger';

export interface OpenRouterProviderConfig extends AiSdkProviderConfig {
  apiKey: string;
  siteUrl?: string;
  siteName?: string;
  defaultModel?: string;
}

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1';

/** One entry of OpenRouter's GET /models catalog (only the fields read here). */
interface OpenRouterModel {
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

/**
 * OpenRouter Provider using OpenAI-compatible API
 */
export class OpenRouterProvider extends AiSdkProvider<OpenRouterProviderConfig> {
  readonly name = 'openrouter';
  protected readonly fallbackModel = 'openai/gpt-3.5-turbo';
  private logger: Logger;

  /** Loads `@ai-sdk/openai` on first use (it is an optional peer) and points it at OpenRouter. */
  private readonly loadProvider = lazyValue(async () => {
    const { createOpenAI } = await loadOptionalPeer('@ai-sdk/openai', () => import('@ai-sdk/openai'), aiMajorOf(this.ai));
    return createOpenAI({
      apiKey: this.config.apiKey,
      baseURL: OPENROUTER_API_URL,
      headers: buildHeaders(this.config),
    });
  });

  constructor(config: OpenRouterProviderConfig, logger: Logger = noopLogger) {
    super(config);
    this.logger = logger;
  }

  protected async createModel(modelId: string): Promise<LanguageModel> {
    return (await this.loadProvider())(modelId);
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
      throw new Error(`Failed to fetch ${what}: ${response.statusText}`);
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
  async getModelInfo(modelId: string): Promise<any> {
    try {
      const models = await this.fetchModelCatalog('model info');
      return models?.find((model) => model.id === modelId);
    } catch (error) {
      this.logger.warn('Failed to fetch model info', { error: (error as Error).message });
      return null;
    }
  }
}
