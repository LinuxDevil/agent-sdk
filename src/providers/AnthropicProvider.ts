/**
 * Anthropic Provider Implementation
 * Uses the 'ai' SDK for unified interface
 *
 * Shares OpenAIProvider.ts's shape exactly (constructor config, method
 * signatures, message conversion, tool-call conversion, GenerateResult/
 * StreamResult shape) via the common AiSdkProvider base in ./aiSdkProvider -
 * only the underlying 'ai' SDK model factory and model-name lists differ.
 */

import { LanguageModel } from 'ai';
import { AiSdkProvider, AiSdkProviderConfig } from './aiSdkProvider';
import { aiMajorOf } from './aiSdkCompat';
import { lazyValue, loadOptionalPeer } from './optionalPeer';

export interface AnthropicProviderConfig extends AiSdkProviderConfig {
  apiKey: string;
  baseURL?: string;
  defaultModel?: string;
}

/** Model-id prefixes of the Claude families that support tool use. */
const TOOL_CAPABLE_PREFIXES = ['claude-3', 'claude-4', 'claude-sonnet', 'claude-opus', 'claude-haiku'];

/**
 * Anthropic Provider using the 'ai' SDK
 */
export class AnthropicProvider extends AiSdkProvider<AnthropicProviderConfig> {
  readonly name = 'anthropic';
  protected readonly fallbackModel = 'claude-3-5-sonnet-latest';
  /** Loads `@ai-sdk/anthropic` on first use (it is an optional peer). */
  private readonly loadProvider = lazyValue(async () => {
    const { createAnthropic } = await loadOptionalPeer(
      '@ai-sdk/anthropic',
      () => import('@ai-sdk/anthropic'),
      aiMajorOf(this.ai)
    );
    return createAnthropic({
      apiKey: this.config.apiKey,
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
    // All current Claude 3+ models support tool use
    return TOOL_CAPABLE_PREFIXES.some((prefix) => model.startsWith(prefix));
  }

  /**
   * Check if model supports streaming
   */
  supportsStreaming(_model: string): boolean {
    return true; // All Anthropic models support streaming
  }

  /**
   * Get available models
   */
  async getModels(): Promise<string[]> {
    // Return common models (fetching from API requires additional setup)
    return [
      'claude-3-5-sonnet-latest',
      'claude-3-5-haiku-latest',
      'claude-3-opus-latest',
      'claude-3-sonnet-20240229',
      'claude-3-haiku-20240307',
    ];
  }
}
