/**
 * OpenAI Provider Implementation
 * Uses the 'ai' SDK for unified interface (shared logic in ./aiSdkProvider)
 */

import { LanguageModel } from 'ai';
import { AiSdkProvider, AiSdkProviderConfig } from './aiSdkProvider';
import { aiMajorOf } from './aiSdkCompat';
import { lazyValue, loadOptionalPeer } from './optionalPeer';
import { mappedHostedOptions, type HostedOptionMapping } from './hostedToolMapping';
import { hostedToolUnsupported, type HostedTool, type HostedToolType } from '../tools/hosted';
import type { GenerateOptions } from './llm';

/** The `openai.tools` factories the hosted helpers map to (N1a). */
type OpenAIToolFactories = Partial<Record<'webSearch' | 'codeInterpreter' | 'fileSearch', (args: Record<string, unknown>) => unknown>>;

/** How one helper maps to its factory: the factory, and each helper option to the factory's argument (`undefined`: OpenAI has none). */
interface OpenAIToolMapping {
  factory: keyof OpenAIToolFactories;
  options: HostedOptionMapping;
}

const OPENAI_HOSTED_TOOLS: Record<HostedToolType, OpenAIToolMapping> = {
  web_search: {
    factory: 'webSearch',
    options: {
      searchContextSize: (searchContextSize) => ({ searchContextSize }),
      userLocation: (location) => ({ userLocation: { type: 'approximate', ...(location as object) } }),
      allowedDomains: (allowedDomains) => ({ filters: { allowedDomains } }),
      maxUses: undefined,
      blockedDomains: undefined,
    },
  },
  code_interpreter: { factory: 'codeInterpreter', options: { container: (container) => ({ container }) } },
  file_search: {
    factory: 'fileSearch',
    options: { vectorStoreIds: (vectorStoreIds) => ({ vectorStoreIds }), maxResults: (maxNumResults) => ({ maxNumResults }) },
  },
};

export interface OpenAIProviderConfig extends AiSdkProviderConfig {
  apiKey: string;
  organization?: string;
  baseURL?: string;
  defaultModel?: string;
  /**
   * Which OpenAI API the model calls: `'responses'` (default, `/responses`) or
   * `'chat'` (`/chat/completions`). Use `'chat'` for OpenAI-compatible servers
   * that only implement Chat Completions (llama.cpp, vLLM, Ollama's `/v1`, Groq,
   * DeepSeek, ...). Hosted tools (`webSearch()`, `codeInterpreter()`,
   * `fileSearch()`) need `'responses'`; `hostedTool()` pass-through works on both.
   */
  api?: 'responses' | 'chat';
}

/**
 * OpenAI Provider using the 'ai' SDK
 */
export class OpenAIProvider extends AiSdkProvider<OpenAIProviderConfig> {
  readonly name = 'openai';
  protected readonly mapsHostedTools = true;
  protected readonly fallbackModel = 'gpt-4o-mini';
  /** Loads `@ai-sdk/openai` on first use (it is an optional peer). */
  private readonly loadProvider = lazyValue(async () => {
    const { createOpenAI } = await loadOptionalPeer('@ai-sdk/openai', () => import('@ai-sdk/openai'), aiMajorOf(this.ai));
    return createOpenAI({
      apiKey: this.config.apiKey,
      organization: this.config.organization,
      baseURL: this.config.baseURL,
      headers: this.config.headers,
      ...(this.config.fetch && { fetch: this.config.fetch }),
    });
  });

  /** PDF file parts go to the model on ai 6 and 7; older peers have no file parts. */
  protected fileMediaTypes(): readonly string[] {
    return aiMajorOf(this.ai) >= 6 ? ['application/pdf'] : [];
  }

  /** `api: 'chat'`: the Chat Completions API (`/chat/completions`) instead of the Responses API. */
  private get usesChat(): boolean {
    return this.config.api === 'chat';
  }

  protected async createModel(modelId: string): Promise<LanguageModel> {
    const provider = await this.loadProvider();
    // `@ai-sdk/openai` 2+ makes the bare call a Responses API model; `.chat()` is Chat Completions on every major.
    return this.usesChat ? provider.chat(modelId) : provider(modelId);
  }

  /** Chat Completions has no reasoning summary, so only the effort is sent. */
  protected reasoningOptions(modelId: string, options: GenerateOptions): Record<string, unknown> | undefined {
    const sent = super.reasoningOptions(modelId, options);
    if (!this.usesChat || !sent) return sent;
    const { reasoningSummary: _summary, ...openai } = sent.openai as Record<string, unknown>;
    return { ...sent, openai };
  }

  /**
   * N1a: web search, code interpreter, file search and `hostedTool()`, on ai 6 (@ai-sdk/openai 3) and ai 7 (@ai-sdk/openai 4).
   * With `api: 'chat'` only `hostedTool()` pass-through: the built-in tools are Responses API tools.
   */
  supportsHostedTool(type: HostedToolType | 'custom'): boolean {
    if (this.usesChat) return super.supportsHostedTool(type);
    return aiMajorOf(this.ai) >= 6;
  }

  /**
   * N1a: the helpers as `@ai-sdk/openai`'s provider tools (`openai.tools.webSearch()`,
   * `.codeInterpreter()`, `.fileSearch()`), keyed `web_search`, `code_interpreter`
   * and `file_search`; `hostedTool()` objects pass through. The bare model is a
   * Responses API model from @ai-sdk/openai 2 on, which hosted tools need.
   */
  protected async hostedToolsFor(tools: readonly HostedTool[], _modelId: string): Promise<Record<string, unknown>> {
    const { passed: result, builtIn } = this.splitHostedTools(tools);
    if (builtIn.length === 0) return result;
    if (this.usesChat) {
      throw hostedToolUnsupported(this.name, builtIn[0], `${builtIn[0].type} is a Responses API tool, and this provider is set to api: 'chat'`);
    }
    const factories = ((await this.loadProvider()) as unknown as { tools?: OpenAIToolFactories }).tools;
    for (const tool of builtIn) {
      const mapping = OPENAI_HOSTED_TOOLS[tool.type as HostedToolType];
      const factory = factories?.[mapping.factory];
      if (typeof factory !== 'function') {
        throw hostedToolUnsupported(
          this.name,
          tool,
          `the installed @ai-sdk/openai has no tools.${mapping.factory}() (it needs @ai-sdk/openai 3 with ai 6, or 4 with ai 7)`
        );
      }
      result[tool.name] = factory(mappedHostedOptions('OpenAI', tool, mapping.options));
    }
    return result;
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
