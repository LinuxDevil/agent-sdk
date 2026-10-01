/**
 * Ollama Provider Implementation
 * Uses the 'ai' SDK with ollama-ai-provider (shared logic in ./aiSdkProvider)
 */

import { LanguageModel } from 'ai';
import { AiSdkProvider, AiSdkProviderConfig } from './aiSdkProvider';
import { aiMajorOf } from './aiSdkCompat';
import { lazyValue, loadOptionalPeer } from './optionalPeer';
import { Logger, noopLogger } from '../execution/logger';

export interface OllamaProviderConfig extends AiSdkProviderConfig {
  baseURL?: string;
  defaultModel?: string;
}

/**
 * Ollama Provider using the 'ai' SDK
 */
export class OllamaProvider extends AiSdkProvider<OllamaProviderConfig> {
  readonly name = 'ollama';
  protected readonly fallbackModel = 'llama3.1';
  private logger: Logger;

  /**
   * Loads the Ollama package on first use (an optional peer): `ollama-ai-provider`
   * on `ai` 4, `ollama-ai-provider-v2` on `ai` 6/7 (LOU-D28d).
   */
  private readonly loadProvider = lazyValue(async () => {
    const major = aiMajorOf(this.ai);
    const { createOllama } =
      major === 4
        ? await loadOptionalPeer('ollama-ai-provider', () => import('ollama-ai-provider'), major)
        : await loadOptionalPeer('ollama-ai-provider-v2', () => import('ollama-ai-provider-v2'), major);
    return { modern: major !== 4, ollama: createOllama({ baseURL: this.config.baseURL || 'http://localhost:11434' }) };
  });

  constructor(config: OllamaProviderConfig, logger: Logger = noopLogger) {
    super(config);
    this.logger = logger;
  }

  protected async createModel(modelId: string): Promise<LanguageModel> {
    const { modern, ollama } = await this.loadProvider();
    // The v2 package takes no per-model settings: it streams and does structured output natively.
    return modern ? ollama(modelId) : ollama(modelId, { simulateStreaming: true, structuredOutputs: true });
  }

  /**
   * Check if model supports tools
   */
  supportsTools(model: string): boolean {
    // Newer Llama models support tools
    return model.includes('llama3') || model.includes('mistral');
  }

  /**
   * Check if model supports streaming
   */
  supportsStreaming(_model: string): boolean {
    return true; // All Ollama models support streaming
  }

  /**
   * Get available models
   */
  async getModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.config.baseURL || 'http://localhost:11434'}/api/tags`);
      const data = await response.json();
      return data.models?.map((m: any) => m.name) || [];
    } catch (error) {
      this.logger.warn('Failed to fetch Ollama models', { error: (error as Error).message });
      return ['llama3.1', 'llama2', 'mistral'];
    }
  }
}
