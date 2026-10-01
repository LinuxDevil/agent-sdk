/**
 * OpenAI Provider Implementation
 * Uses the 'ai' SDK for unified interface (shared logic in ./aiSdkProvider)
 */

import { createOpenAI } from '@ai-sdk/openai';
import { LanguageModel } from 'ai';
import { AiSdkProvider, AiSdkProviderConfig } from './aiSdkProvider';

export interface OpenAIProviderConfig extends AiSdkProviderConfig {
  apiKey: string;
  organization?: string;
  baseURL?: string;
  defaultModel?: string;
}

/**
 * OpenAI Provider using the 'ai' SDK
 */
export class OpenAIProvider extends AiSdkProvider<OpenAIProviderConfig> {
  readonly name = 'openai';
  protected readonly fallbackModel = 'gpt-4';
  private provider: ReturnType<typeof createOpenAI>;

  constructor(config: OpenAIProviderConfig) {
    super(config);
    this.provider = createOpenAI({
      apiKey: config.apiKey,
      organization: config.organization,
      baseURL: config.baseURL,
      headers: config.headers,
    });
  }

  protected createModel(modelId: string): LanguageModel {
    return this.provider(modelId);
  }

  /**
   * Check if model supports tools
   */
  supportsTools(model: string): boolean {
    // Most GPT models support tools
    return model.startsWith('gpt-4') || model.startsWith('gpt-3.5-turbo');
  }

  /**
   * Check if model supports streaming
   */
  supportsStreaming(_model: string): boolean {
    return true; // All OpenAI models support streaming
  }

  /**
   * Get available models
   */
  async getModels(): Promise<string[]> {
    // Return common models (fetching from API requires additional setup)
    return [
      'gpt-4',
      'gpt-4-turbo',
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-3.5-turbo',
    ];
  }
}
