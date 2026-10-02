/**
 * OpenAI Provider Implementation
 * Uses the 'ai' SDK for unified interface (shared logic in ./aiSdkProvider)
 */

import { LanguageModel } from 'ai';
import { AiSdkProvider, AiSdkProviderConfig } from './aiSdkProvider';
import { aiMajorOf } from './aiSdkCompat';
import { lazyValue, loadOptionalPeer } from './optionalPeer';
import { hostedToolUnsupported, type HostedTool, type HostedToolType } from '../tools/hosted';

/** The `openai.tools` factories the hosted helpers map to (N1a). */
type OpenAIToolFactories = Partial<Record<'webSearch' | 'codeInterpreter' | 'fileSearch', (args: Record<string, unknown>) => unknown>>;

/** How one helper maps to its factory: the factory, and each helper option to the factory's argument (`undefined`: OpenAI has none). */
interface OpenAIToolMapping {
  factory: keyof OpenAIToolFactories;
  options: Record<string, ((value: unknown) => Record<string, unknown>) | undefined>;
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

/** `tool name: options` already warned about (once per process). */
const warnedOptions = new Set<string>();

/** A helper's options as the factory's arguments; options OpenAI does not take are dropped with one warning. */
function openAIToolArgs(tool: HostedTool, mapping: OpenAIToolMapping): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(tool.options)) {
    const map = mapping.options[key];
    if (map) Object.assign(args, map(value));
    else dropped.push(key);
  }
  const warnKey = `${tool.name}:${dropped.join(',')}`;
  if (dropped.length > 0 && !warnedOptions.has(warnKey)) {
    warnedOptions.add(warnKey);
    console.warn(`[lousho] OpenAI's ${tool.name} tool does not take ${dropped.join(', ')}; ignored.`);
  }
  return args;
}

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
    const { createOpenAI } = await loadOptionalPeer('@ai-sdk/openai', () => import('@ai-sdk/openai'), aiMajorOf(this.ai));
    return createOpenAI({
      apiKey: this.config.apiKey,
      organization: this.config.organization,
      baseURL: this.config.baseURL,
      headers: this.config.headers,
    });
  });

  /** PDF file parts go to the model on ai 6 and 7; older peers have no file parts. */
  protected fileMediaTypes(): readonly string[] {
    return aiMajorOf(this.ai) >= 6 ? ['application/pdf'] : [];
  }

  protected async createModel(modelId: string): Promise<LanguageModel> {
    return (await this.loadProvider())(modelId);
  }

  /** N1a: web search, code interpreter, file search and `hostedTool()`, on ai 6 (@ai-sdk/openai 3) and ai 7 (@ai-sdk/openai 4). */
  supportsHostedTool(_type: HostedToolType | 'custom'): boolean {
    return aiMajorOf(this.ai) >= 6;
  }

  /**
   * N1a: the helpers as `@ai-sdk/openai`'s provider tools (`openai.tools.webSearch()`,
   * `.codeInterpreter()`, `.fileSearch()`), keyed `web_search`, `code_interpreter`
   * and `file_search`; `hostedTool()` objects pass through. The bare model is a
   * Responses API model from @ai-sdk/openai 2 on, which hosted tools need.
   */
  protected async hostedToolsFor(tools: readonly HostedTool[], modelId: string): Promise<Record<string, unknown>> {
    // On ai 4 the base rejects every hosted tool.
    if (aiMajorOf(this.ai) < 6) return super.hostedToolsFor(tools, modelId);
    const result = await super.hostedToolsFor(tools.filter((tool) => tool.type === 'custom'), modelId);
    const builtIn = tools.filter((tool) => tool.type !== 'custom');
    if (builtIn.length === 0) return result;
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
      result[tool.name] = factory(openAIToolArgs(tool, mapping));
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
