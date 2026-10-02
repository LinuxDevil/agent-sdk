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
import { mappedHostedOptions, type HostedOptionMapping } from './hostedToolMapping';
import { hostedToolUnsupported, type HostedTool, type HostedToolType } from '../tools/hosted';

/** How one helper maps to `anthropic.tools`: the dated factories' name prefix, and each helper option to the factory's argument. */
interface AnthropicToolMapping {
  prefix: 'webSearch_' | 'codeExecution_';
  options: HostedOptionMapping;
}

/** N1b: web search and code execution; Anthropic has no hosted file search. */
const ANTHROPIC_HOSTED_TOOLS: Partial<Record<HostedToolType, AnthropicToolMapping>> = {
  web_search: {
    prefix: 'webSearch_',
    options: {
      maxUses: (maxUses) => ({ maxUses }),
      allowedDomains: (allowedDomains) => ({ allowedDomains }),
      blockedDomains: (blockedDomains) => ({ blockedDomains }),
      userLocation: (location) => ({ userLocation: { type: 'approximate', ...(location as object) } }),
      searchContextSize: undefined,
    },
  },
  code_interpreter: { prefix: 'codeExecution_', options: { container: undefined } },
};

/** The newest dated factory (`webSearch_20260318` before `webSearch_20250305`) of `prefix` in `tools`. */
function newestFactory(tools: Record<string, unknown> | undefined, prefix: string): ((args: Record<string, unknown>) => unknown) | undefined {
  const name = Object.keys(tools ?? {})
    .filter((key) => key.startsWith(prefix) && /^\d+$/.test(key.slice(prefix.length)) && typeof tools?.[key] === 'function')
    .sort((a, b) => b.localeCompare(a))[0];
  return name ? (tools?.[name] as (args: Record<string, unknown>) => unknown) : undefined;
}

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
  protected readonly mapsHostedTools = true;
  protected readonly fallbackModel = 'claude-3-5-sonnet-latest';
  /** LOU-V13: thinking blocks go back unmodified with their tool-call turn. */
  protected readonly replaysReasoning = true;
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

  /** PDF file parts go to the model on ai 6 and 7; older peers have no file parts. */
  protected fileMediaTypes(): readonly string[] {
    return aiMajorOf(this.ai) >= 6 ? ['application/pdf', 'text/plain'] : [];
  }

  protected async createModel(modelId: string): Promise<LanguageModel> {
    return (await this.loadProvider())(modelId);
  }

  /** N1b: web search and code execution, on ai 6 (@ai-sdk/anthropic 3) and ai 7 (@ai-sdk/anthropic 4); `hostedTool()` passes through. */
  supportsHostedTool(type: HostedToolType | 'custom'): boolean {
    return aiMajorOf(this.ai) >= 6 && (type === 'custom' || type in ANTHROPIC_HOSTED_TOOLS);
  }

  /**
   * N1b: the helpers as `@ai-sdk/anthropic`'s server tools: `web_search` is the
   * newest `tools.webSearch_*()` the installed package has, `code_interpreter`
   * the newest `tools.codeExecution_*()` (Anthropic calls it `code_execution`;
   * events keep our name). `file_search` has no Anthropic equivalent.
   */
  protected async hostedToolsFor(tools: readonly HostedTool[], _modelId: string): Promise<Record<string, unknown>> {
    const { passed: result, builtIn } = this.splitHostedTools(tools);
    if (builtIn.length === 0) return result;
    const factories = ((await this.loadProvider()) as unknown as { tools?: Record<string, unknown> }).tools;
    for (const tool of builtIn) {
      const mapping = ANTHROPIC_HOSTED_TOOLS[tool.type as HostedToolType];
      if (!mapping) throw hostedToolUnsupported(this.name, tool, 'Anthropic has no hosted file search');
      const factory = newestFactory(factories, mapping.prefix);
      if (!factory) {
        throw hostedToolUnsupported(
          this.name,
          tool,
          `the installed @ai-sdk/anthropic has no tools.${mapping.prefix}<date>() (it needs @ai-sdk/anthropic 3 with ai 6, or 4 with ai 7)`
        );
      }
      result[tool.name] = factory(mappedHostedOptions('Anthropic', tool, mapping.options));
    }
    return result;
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
