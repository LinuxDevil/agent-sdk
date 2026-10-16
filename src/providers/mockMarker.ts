import type { LLMProvider } from './llm';

/** Set on `mockModel()`'s provider: it makes no network call and costs nothing. Symbol.for so every bundle of the SDK agrees. */
export const MOCK_PROVIDER = Symbol.for('lousho.mockProvider');

/** Whether `provider` is a scripted `mockModel()`. */
export function isMockProvider(provider: LLMProvider | undefined): boolean {
  return !!provider && (provider as { [MOCK_PROVIDER]?: boolean })[MOCK_PROVIDER] === true;
}
