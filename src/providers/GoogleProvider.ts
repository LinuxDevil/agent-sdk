/**
 * Google (Gemini) Provider Implementation
 * Uses the 'ai' SDK with `@ai-sdk/google` (shared logic in ./aiSdkProvider)
 */

import { LanguageModel } from 'ai';
import { AiSdkProvider, AiSdkProviderConfig } from './aiSdkProvider';
import { aiMajorOf, documentFileTypes } from './aiSdkCompat';
import { lazyValue, loadOptionalPeer } from './optionalPeer';

export interface GoogleProviderConfig extends AiSdkProviderConfig {
  /** Gemini API key; `@ai-sdk/google` falls back to `GOOGLE_GENERATIVE_AI_API_KEY` when it is unset. */
  apiKey?: string;
  baseURL?: string;
  defaultModel?: string;
}

/**
 * Google Gemini Provider using the 'ai' SDK
 */
export class GoogleProvider extends AiSdkProvider<GoogleProviderConfig> {
  readonly name = 'google';
  protected readonly fallbackModel = 'gemini-2.5-flash';
  /** Loads `@ai-sdk/google` on first use (it is an optional peer). */
  private readonly loadProvider = lazyValue(async () => {
    const { createGoogleGenerativeAI } = await loadOptionalPeer('@ai-sdk/google', () => import('@ai-sdk/google'), aiMajorOf(this.ai));
    return createGoogleGenerativeAI(this.clientOptions());
  });

  /** PDF and plain-text file parts go to the model on ai 6 and 7; older peers have no file parts. */
  protected fileMediaTypes(): readonly string[] {
    return documentFileTypes(this.ai);
  }

  protected async createModel(modelId: string): Promise<LanguageModel> {
    return (await this.loadProvider())(modelId);
  }

  /**
   * Whether `model` calls tools: every Gemini model. Informational: the
   * runtime does not consult it.
   */
  supportsTools(model: string): boolean {
    return model.startsWith('gemini');
  }

  supportsStreaming(_model: string): boolean {
    return true;
  }

  /** Current Gemini models (fetching from the API requires additional setup). */
  async getModels(): Promise<string[]> {
    return ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];
  }
}
