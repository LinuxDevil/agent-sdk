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
   * Unset, the `LOUSHO_OPENAI_API` environment variable (`chat` or `responses`)
   * decides, so an `openai/<model>` string with `OPENAI_BASE_URL` can reach a
   * Chat-Completions-only server.
   */
  api?: 'responses' | 'chat';
  /**
   * Whether OpenAI keeps Responses API calls server-side (its `store`). Default
   * `false`: the SDK sends the whole transcript on every call and never refers
   * to a stored response, so nothing needs storing. Ignored with `api: 'chat'`.
   */
  store?: boolean;
}

/** `process.env`, where there is one (not in a browser or Worker). */
function processEnv(): Record<string, string | undefined> | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
}

/** `LOUSHO_OPENAI_API`, where there is a `process.env`. */
function envApi(): string | undefined {
  return processEnv()?.LOUSHO_OPENAI_API?.trim().toLowerCase();
}

/**
 * OpenAI Provider using the 'ai' SDK
 */
export class OpenAIProvider extends AiSdkProvider<OpenAIProviderConfig> {
  readonly name = 'openai';
  protected readonly mapsHostedTools = true;
  protected readonly checksChatFailures = true;
  protected readonly fallbackModel = 'gpt-4o-mini';
  /** Loads `@ai-sdk/openai` on first use (it is an optional peer). */
  private readonly loadProvider = lazyValue(async () => {
    const { createOpenAI } = await loadOptionalPeer('@ai-sdk/openai', () => import('@ai-sdk/openai'), aiMajorOf(this.ai));
    // `@ai-sdk/openai` 2+ reads OPENAI_BASE_URL itself; 0.x/1.x (the ai 4 line) does not, so it is passed explicitly.
    const baseURL = this.config.baseURL ?? (processEnv()?.OPENAI_BASE_URL || undefined);
    return createOpenAI({ ...this.clientOptions(), baseURL, organization: this.config.organization });
  });

  /** PDF file parts go to the model on ai 6 and 7; older peers have no file parts. */
  protected fileMediaTypes(): readonly string[] {
    return aiMajorOf(this.ai) >= 6 ? ['application/pdf'] : [];
  }

  /** `api: 'chat'` (or `LOUSHO_OPENAI_API=chat`): the Chat Completions API (`/chat/completions`) instead of the Responses API. */
  private get usesChat(): boolean {
    return (this.config.api ?? envApi()) === 'chat';
  }

  protected async createModel(modelId: string): Promise<LanguageModel> {
    const provider = await this.loadProvider();
    // `@ai-sdk/openai` 2+ makes the bare call a Responses API model; `.chat()` is Chat Completions on every major.
    return this.usesChat ? provider.chat(modelId) : provider(modelId);
  }

  /**
   * The call's `providerOptions`: the reasoning (Chat Completions has no
   * reasoning summary, so only the effort is sent there) and, on the Responses
   * API of `@ai-sdk/openai` 3+, `store` (default `false`).
   */
  protected reasoningOptions(modelId: string, options: GenerateOptions): Record<string, unknown> | undefined {
    const sent = super.reasoningOptions(modelId, options);
    if (this.usesChat) {
      if (!sent) return sent;
      const { reasoningSummary: _summary, ...openai } = sent.openai as Record<string, unknown>;
      return { ...sent, openai };
    }
    if (aiMajorOf(this.ai) < 6) return sent;
    return { ...sent, openai: { ...(sent?.openai as Record<string, unknown> | undefined), store: this.config.store ?? false } };
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
   * Whether this provider sends tools for `model`: always (current OpenAI
   * models all call tools; a model that cannot is rejected by the API).
   * Informational: the runtime does not consult it.
   */
  supportsTools(_model: string): boolean {
    return true;
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
    // Current models with a built-in price (fetching from the API requires additional setup)
    return ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o', 'gpt-4o-mini', 'o3', 'o4-mini'];
  }
}
