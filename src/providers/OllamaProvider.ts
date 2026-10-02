/**
 * Ollama Provider Implementation
 * Uses the 'ai' SDK with ollama-ai-provider (shared logic in ./aiSdkProvider)
 */

import { LanguageModel } from 'ai';
import { AiSdkProvider, AiSdkProviderConfig } from './aiSdkProvider';
import { aiMajorOf } from './aiSdkCompat';
import { lazyValue, loadOptionalPeer } from './optionalPeer';
import { Logger, noopLogger } from '../execution/logger';
import type { GenerateOptions } from './llm';

export interface OllamaProviderConfig extends AiSdkProviderConfig {
  baseURL?: string;
  defaultModel?: string;
}

const OLLAMA_DEFAULT_URL = 'http://localhost:11434';

/**
 * The URL both Ollama packages expect: they append `/chat`, `/tags` to a base that ends in `/api`.
 * A bare host (`http://host:11434`, with or without a trailing slash) gets `/api` added; a URL with
 * any other path (`/api`, `/api/`, a reverse-proxy prefix) is kept as configured.
 */
function normalizeOllamaBaseUrl(baseURL: string | undefined): string {
  const trimmed = (baseURL || OLLAMA_DEFAULT_URL).replace(/\/+$/, '');
  return /^[a-z][a-z0-9+.-]*:\/\/[^/]+$/i.test(trimmed) ? `${trimmed}/api` : trimmed;
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
    return { modern: major !== 4, ollama: createOllama({ baseURL: normalizeOllamaBaseUrl(this.config.baseURL) }) };
  });

  constructor(config: OllamaProviderConfig, logger: Logger = noopLogger) {
    super(config);
    this.logger = logger;
  }

  /** LOU-V13: `think` needs `ollama-ai-provider-v2` (`ai` 6/7); on `ai` 4 the option is ignored, with one warning. */
  protected reasoningOptions(modelId: string, options: GenerateOptions): Record<string, unknown> | undefined {
    const sent = super.reasoningOptions(modelId, options);
    if (!sent || aiMajorOf(this.ai) !== 4) return sent;
    if (!this.warnedReasoning) console.warn('[lousho] ollama-ai-provider (ai 4) cannot send `reasoning`; it is ignored.');
    this.warnedReasoning = true;
    return undefined;
  }
  private warnedReasoning = false;

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
      const response = await fetch(`${normalizeOllamaBaseUrl(this.config.baseURL)}/tags`);
      const data = (await response.json()) as { models?: Array<{ name: string }> };
      return data.models?.map((m) => m.name) || [];
    } catch (error) {
      this.logger.warn('Failed to fetch Ollama models', { error: (error as Error).message });
      return ['llama3.1', 'llama2', 'mistral'];
    }
  }
}
