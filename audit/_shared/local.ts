import { OpenAIProvider } from '@lousho/build-ai-agent';

export const LOCAL_BASE_URL = process.env.LOCAL_LLM_BASE_URL ?? 'http://localhost:1234/v1';
export const LOCAL_MODEL = process.env.LOCAL_LLM_MODEL ?? 'qwen3.5-9b-uncensored-hauhaucs-aggressive';
export const LOCAL_EMBED_MODEL = 'text-embedding-nomic-embed-text-v1.5';

/** An OpenAIProvider pointed at the local LM Studio server. */
export function localProvider(model: string = LOCAL_MODEL): OpenAIProvider {
  return new OpenAIProvider({ apiKey: 'lm-studio', baseURL: LOCAL_BASE_URL, defaultModel: model });
}
