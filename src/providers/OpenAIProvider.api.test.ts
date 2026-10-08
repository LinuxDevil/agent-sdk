/**
 * `OpenAIProvider({ api })` (audit C5): `'responses'` (the default) builds the bare
 * `@ai-sdk/openai` model, the Responses API on @ai-sdk/openai 2+; `'chat'` builds
 * `.chat(id)`, the Chat Completions API that llama.cpp, vLLM and Ollama's `/v1`
 * implement. `@ai-sdk/openai` is stubbed so the two factories are told apart on
 * every installed major; hosted tools and reasoning run on `ai` v7.
 */

import { describe, expect, it, vi } from 'vitest';
import * as aiV7 from 'ai-v7';
import { OpenAIProvider, type OpenAIProviderConfig } from './OpenAIProvider';
import type { AiSdkModule } from './aiSdkCompat';
import type { GenerateOptions } from './llm';
import { hostedTool, webSearch } from '../tools/hosted';

const webSearchFactory = vi.fn((args: Record<string, unknown>) => ({ type: 'provider', id: 'openai.web_search', args }));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: () =>
    Object.assign((id: string) => ({ api: 'responses', id }), {
      chat: (id: string) => ({ api: 'chat', id }),
      tools: { webSearch: webSearchFactory },
    }),
}));

type Internals = {
  createModel(id: string): Promise<{ api: string; id: string }>;
  hostedToolsFor(tools: unknown[], id: string): Promise<Record<string, unknown>>;
  reasoningOptions(id: string, options: GenerateOptions): Record<string, unknown> | undefined;
};

function openAI(config: Partial<OpenAIProviderConfig> = {}): OpenAIProvider & Internals {
  const provider = new OpenAIProvider({ name: 'openai', apiKey: 'any', maxRetries: 0, ...config });
  Object.assign(provider, { ai: aiV7 as AiSdkModule });
  return provider as OpenAIProvider & Internals;
}

describe('OpenAIProvider api option', () => {
  it('defaults to the Responses API model', async () => {
    expect(await openAI().createModel('gpt-4o')).toEqual({ api: 'responses', id: 'gpt-4o' });
    expect(await openAI({ api: 'responses' }).createModel('gpt-4o')).toEqual({ api: 'responses', id: 'gpt-4o' });
  });

  it("api: 'chat' builds the Chat Completions model", async () => {
    const provider = openAI({ api: 'chat', baseURL: 'http://localhost:1234/v1' });
    expect(await provider.createModel('qwen3')).toEqual({ api: 'chat', id: 'qwen3' });
  });

  it("api: 'chat' supports only hostedTool() pass-through", async () => {
    const provider = openAI({ api: 'chat' });
    expect(provider.supportsHostedTool('web_search')).toBe(false);
    expect(provider.supportsHostedTool('code_interpreter')).toBe(false);
    expect(provider.supportsHostedTool('custom')).toBe(true);
    expect(openAI().supportsHostedTool('web_search')).toBe(true);

    const custom = hostedTool('lookup', { type: 'provider', id: 'x.lookup', args: {} });
    await expect(provider.hostedToolsFor([custom], 'm')).resolves.toHaveProperty('lookup');
    await expect(provider.hostedToolsFor([webSearch()], 'm')).rejects.toMatchObject({
      code: 'LOUSHO_HOSTED_TOOL_UNSUPPORTED',
      message: expect.stringContaining("api: 'chat'"),
    });
    expect(webSearchFactory).not.toHaveBeenCalled();
  });

  it("api: 'chat' sends the reasoning effort without the Responses-only summary", () => {
    const options: GenerateOptions = { messages: [], reasoning: { effort: 'high', summary: 'auto' } };
    expect(openAI().reasoningOptions('o3', options)).toEqual({ openai: { reasoningEffort: 'high', reasoningSummary: 'auto' } });
    expect(openAI({ api: 'chat' }).reasoningOptions('o3', options)).toEqual({ openai: { reasoningEffort: 'high' } });
    expect(openAI({ api: 'chat' }).reasoningOptions('qwen3', options)).toBeUndefined();
  });
});
