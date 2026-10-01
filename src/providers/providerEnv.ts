/**
 * The single source of truth for which env var holds each real provider's
 * credential/config, and which optional peer package implements it. Shared
 * by resolveProvider() and `loushy doctor` (kept out of the providers barrel
 * so it is not public API).
 */

export interface ProviderEnvEntry {
  /** Env var that holds the credential or endpoint. */
  envKey: string;
  /** LLMProviderConfig field the env value belongs in. */
  configField: 'apiKey' | 'baseURL';
  /** Optional peer dependency that implements this provider. */
  peerPackage: string;
}

export const PROVIDER_ENV_TABLE: Record<string, ProviderEnvEntry> = {
  openai: { envKey: 'OPENAI_API_KEY', configField: 'apiKey', peerPackage: '@ai-sdk/openai' },
  anthropic: { envKey: 'ANTHROPIC_API_KEY', configField: 'apiKey', peerPackage: '@ai-sdk/anthropic' },
  ollama: { envKey: 'OLLAMA_BASE_URL', configField: 'baseURL', peerPackage: 'ollama-ai-provider' },
  openrouter: { envKey: 'OPENROUTER_API_KEY', configField: 'apiKey', peerPackage: '@ai-sdk/openai' },
};
