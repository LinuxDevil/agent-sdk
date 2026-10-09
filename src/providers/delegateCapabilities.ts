import type { LLMProvider } from './llm';

/**
 * The capability checks of `provider`, for a wrapper (`withRetry()`,
 * `withRateLimit()`) that changes only how calls go out. An absent
 * `supportsHostedTool` on the wrapped provider means no hosted tools (N1a).
 */
export function delegateCapabilities(
  provider: LLMProvider
): Pick<LLMProvider, 'supportsTools' | 'supportsStreaming' | 'getModels'> & { supportsHostedTool: NonNullable<LLMProvider['supportsHostedTool']> } {
  return {
    supportsTools: (model) => provider.supportsTools(model),
    supportsStreaming: (model) => provider.supportsStreaming(model),
    getModels: () => provider.getModels(),
    supportsHostedTool: (type) => provider.supportsHostedTool?.(type) ?? false,
  };
}
