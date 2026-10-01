/**
 * Ollama Provider Implementation
 * Uses the 'ai' SDK with ollama-ai-provider (shared logic in ./aiSdkProvider)
 */

import { createOllama } from 'ollama-ai-provider';
import { LanguageModel } from 'ai';
import { AiSdkProvider, AiSdkProviderConfig } from './aiSdkProvider';
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
  private provider: ReturnType<typeof createOllama>;
  private logger: Logger;

  constructor(config: OllamaProviderConfig, logger: Logger = noopLogger) {
    super(config);
    this.logger = logger;
    this.provider = createOllama({
      baseURL: config.baseURL || 'http://localhost:11434',
    });
  }

  protected createModel(modelId: string): LanguageModel {
    return this.provider(modelId, {
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
