/**
 * Ollama Provider Implementation
 * Uses the 'ai' SDK with ollama-ai-provider (shared logic in ./aiSdkProvider)
 */

import { LanguageModel } from 'ai';
import { AiSdkProvider, AiSdkProviderConfig } from './aiSdkProvider';
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

  /** Loads `ollama-ai-provider` on first use (it is an optional peer). */
  private readonly loadProvider = lazyValue(async () => {
    const { createOllama } = await loadOptionalPeer('ollama-ai-provider', () => import('ollama-ai-provider'));
    return createOllama({
      baseURL: this.config.baseURL || 'http://localhost:11434',
    });
  });

  constructor(config: OllamaProviderConfig, logger: Logger = noopLogger) {
    super(config);
    this.logger = logger;
  }

  protected async createModel(modelId: string): Promise<LanguageModel> {
    return (await this.loadProvider())(modelId, {
      simulateStreaming: true,
      structuredOutputs: true,
    });
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
