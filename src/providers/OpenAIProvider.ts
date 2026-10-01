/**
 * OpenAI Provider Implementation
 * Uses the 'ai' SDK for unified interface (shared logic in ./aiSdkProvider)
 */

import { LanguageModel } from 'ai';
import { AiSdkProvider, AiSdkProviderConfig } from './aiSdkProvider';
import { lazyValue, loadOptionalPeer } from './optionalPeer';

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
  /** Loads `@ai-sdk/openai` on first use (it is an optional peer). */
  private readonly loadProvider = lazyValue(async () => {
    const { createOpenAI } = await loadOptionalPeer('@ai-sdk/openai', () => import('@ai-sdk/openai'));
    return createOpenAI({
      apiKey: this.config.apiKey,
      organization: this.config.organization,
      baseURL: this.config.baseURL,
      headers: this.config.headers,
    });
  });

  protected async createModel(modelId: string): Promise<LanguageModel> {
    return (await this.loadProvider())(modelId);
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
