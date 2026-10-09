/**
 * LOU-V13: the `reasoning` option as each built-in provider sends it, on `ai`
 * v7 (the `ai-v7` alias, `MockLanguageModelV4`: `providerOptions`) and on the
 * installed `ai` v4 (`MockLanguageModelV1`: `providerMetadata`); the
 * reasoning a model returns; and Anthropic's signed thinking sent back with
 * its tool-call turn.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as aiV7 from 'ai-v7';
import { MockLanguageModelV4 } from 'ai-v7/test';
import { MockLanguageModelV1 } from 'ai/test';
import { OpenAIProvider } from './OpenAIProvider';
import { AnthropicProvider } from './AnthropicProvider';
import { OllamaProvider } from './OllamaProvider';
import { OpenRouterProvider } from './OpenRouterProvider';
import type { LLMProvider, Message } from './llm';
import type { AiSdkModule } from './aiSdkCompat';
import { itOnAiV4 } from './aiMajor.testkit';
import { openRouterReasoning, reasoningProviderOptions } from './reasoning';

type V7Options = Parameters<MockLanguageModelV4['doGenerate']>[0];
type V7Result = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
type V4Options = Parameters<MockLanguageModelV1['doGenerate']>[0];

describe('reasoning that is set but not sent (Eve PROV-F10)', () => {
  it('sends it to Fable, gpt-oss and DeepSeek V3.x on OpenRouter and to Fable on Anthropic', () => {
    for (const model of ['anthropic/claude-fable-5.1', 'openai/gpt-oss-120b', 'deepseek/deepseek-v3.1-terminus']) {
      expect(openRouterReasoning(model, 'low')).toEqual({ reasoning: { effort: 'low' } });
    }
    expect(reasoningProviderOptions('anthropic', 'claude-fable-5-1', 'low')).toEqual({ anthropic: { thinking: { type: 'enabled', budgetTokens: 2048 } } });
  });

  it('warns once per model when it is set but not sent, and not when it is sent or off', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(reasoningProviderOptions('anthropic', 'claude-unlisted-1', 'high')).toBeUndefined();
    expect(reasoningProviderOptions('anthropic', 'claude-unlisted-1', 'high')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("claude-unlisted-1");
    reasoningProviderOptions('anthropic', 'claude-unlisted-2', 'none');
    reasoningProviderOptions('anthropic', 'claude-unlisted-2', undefined);
    reasoningProviderOptions('anthropic', 'claude-unlisted-2', { effort: 'low', force: true });
    reasoningProviderOptions('anthropic', 'claude-sonnet-4-5', 'low');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function useModel(provider: LLMProvider, model: unknown, ai?: AiSdkModule): void {
  if (ai) Object.assign(provider, { ai });
  vi.spyOn(provider as unknown as { createModel: () => Promise<unknown> }, 'createModel').mockResolvedValue(model);
}

const v7Result = (content: V7Result['content'] = [{ type: 'text', text: 'ok' }]): V7Result => ({
  content,
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: {
    inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: undefined },
    outputTokens: { total: 9, text: 2, reasoning: 7 },
  },
  warnings: [],
});

/** Runs `provider` on `ai` v7; returns the options the model got. */
function onV7(provider: LLMProvider, result = v7Result()): V7Options[] {
  const calls: V7Options[] = [];
  useModel(provider, new MockLanguageModelV4({ doGenerate: async (options) => (calls.push(options), result) }), aiV7);
  return calls;
}

/** Runs `provider` on the installed `ai` v4; returns the options the model got. */
function onV4(provider: LLMProvider, reasoning?: Array<{ type: 'text'; text: string; signature?: string }>): V4Options[] {
  const calls: V4Options[] = [];
  const model = new MockLanguageModelV1({
    doGenerate: async (options) => {
      calls.push(options);
      return { text: 'ok', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 2 }, rawCall: { rawPrompt: null, rawSettings: {} }, reasoning };
    },
  });
  useModel(provider, model);
  return calls;
}

const user: Message[] = [{ role: 'user', content: 'Think about it.' }];

describe('reasoning options per provider (LOU-V13)', () => {
  it('maps an effort to OpenAI reasoningEffort (and a summary), Anthropic thinking and Ollama think', () => {
    expect(reasoningProviderOptions('openai', 'o3', 'high')).toEqual({ openai: { reasoningEffort: 'high' } });
    expect(reasoningProviderOptions('openai', 'gpt-5-mini', { effort: 'minimal', summary: 'auto' })).toEqual({
      openai: { reasoningEffort: 'minimal', reasoningSummary: 'auto' },
    });
    expect(reasoningProviderOptions('anthropic', 'claude-sonnet-4-5', 'low')).toEqual({
      anthropic: { thinking: { type: 'enabled', budgetTokens: 2048 } },
    });
    // The effort table: minimal 1024, low 2048, medium 8192 (the default), high 24576.
    const budget = (option: Parameters<typeof reasoningProviderOptions>[2]) =>
      (reasoningProviderOptions('anthropic', 'claude-opus-4-1', option) as { anthropic: { thinking: { budgetTokens: number } } }).anthropic.thinking.budgetTokens;
    expect([budget('minimal'), budget({}), budget('high'), budget({ budgetTokens: 5000 }), budget({ budgetTokens: 10 })]).toEqual([1024, 8192, 24576, 5000, 1024]);
    expect(reasoningProviderOptions('ollama', 'qwen3:8b', 'medium')).toEqual({ ollama: { think: true } });
  });

  it('sends nothing for `none`, a model outside the known reasoning families, or an unknown provider, unless forced', () => {
    expect(reasoningProviderOptions('openai', 'o3', 'none')).toBeUndefined();
    expect(reasoningProviderOptions('openai', 'gpt-4o', 'high')).toBeUndefined();
    expect(reasoningProviderOptions('openai', 'o1-mini', 'high')).toBeUndefined();
    expect(reasoningProviderOptions('openai', 'gpt-5-chat-latest', 'high')).toBeUndefined();
    expect(reasoningProviderOptions('anthropic', 'claude-3-5-sonnet-latest', 'high')).toBeUndefined();
    expect(reasoningProviderOptions('ollama', 'llama3.1', 'high')).toBeUndefined();
    expect(reasoningProviderOptions('mock', 'o3', { effort: 'high', force: true })).toBeUndefined();
    expect(reasoningProviderOptions('openai', 'my-finetune', { effort: 'low', force: true })).toEqual({ openai: { reasoningEffort: 'low' } });
    expect(reasoningProviderOptions('openai', 'o3', undefined)).toBeUndefined();
  });

  it("maps to OpenRouter's unified reasoning field: max_tokens for a budget, else effort", () => {
    expect(openRouterReasoning('deepseek/deepseek-r1', 'high')).toEqual({ reasoning: { effort: 'high' } });
    expect(openRouterReasoning('anthropic/claude-3.7-sonnet', { budgetTokens: 4000 })).toEqual({ reasoning: { max_tokens: 4000 } });
    expect(openRouterReasoning('openai/gpt-4o-mini', 'high')).toBeUndefined();
  });

  it('ai v7: sends them as providerOptions, and none to a model that does not reason', async () => {
    const anthropic = new AnthropicProvider({ apiKey: 'k', maxRetries: 0 });
    const anthropicCalls = onV7(anthropic);
    await anthropic.generate({ messages: user, model: 'claude-sonnet-4-5', reasoning: 'medium' });
    expect(anthropicCalls[0]!.providerOptions).toEqual({ anthropic: { thinking: { type: 'enabled', budgetTokens: 8192 } } });

    const openai = new OpenAIProvider({ apiKey: 'k', maxRetries: 0 });
    const openaiCalls = onV7(openai);
    await openai.generate({ messages: user, model: 'gpt-4o', reasoning: 'high' });
    await openai.generate({ messages: user, model: 'o4-mini', reasoning: 'high' });
    expect(openaiCalls[0]!.providerOptions).toBeUndefined();
    expect(openaiCalls[1]!.providerOptions).toEqual({ openai: { reasoningEffort: 'high' } });

    const ollama = new OllamaProvider({ maxRetries: 0 });
    const ollamaCalls = onV7(ollama);
    await ollama.generate({ messages: user, model: 'qwen3', reasoning: 'low' });
    expect(ollamaCalls[0]!.providerOptions).toEqual({ ollama: { think: true } });
  });

  itOnAiV4('ai v4: sends them as providerOptions (the model gets providerMetadata); Ollama warns once and sends nothing', async () => {
    const anthropic = new AnthropicProvider({ apiKey: 'k', maxRetries: 0 });
    const calls = onV4(anthropic);
    await anthropic.generate({ messages: user, model: 'claude-3-7-sonnet-latest', reasoning: { budgetTokens: 3000 } });
    expect(calls[0]!.providerMetadata).toEqual({ anthropic: { thinking: { type: 'enabled', budgetTokens: 3000 } } });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ollama = new OllamaProvider({ maxRetries: 0 });
    const ollamaCalls = onV4(ollama);
    await ollama.generate({ messages: user, model: 'deepseek-r1', reasoning: 'high' });
    await ollama.generate({ messages: user, model: 'deepseek-r1', reasoning: 'high' });
    expect(ollamaCalls[0]!.providerMetadata).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('OpenRouter adds `reasoning` to the request body for a reasoning model only', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ error: { message: 'stub' } }), { status: 400 });
    }));
    const provider = new OpenRouterProvider({ apiKey: 'k', maxRetries: 0 });
    await expect(provider.generate({ messages: user, model: 'deepseek/deepseek-r1', reasoning: 'high' })).rejects.toThrow();
    await expect(provider.generate({ messages: user, model: 'qwen/qwen3-32b', reasoning: { budgetTokens: 2000 } })).rejects.toThrow();
    await expect(provider.generate({ messages: user, model: 'openai/gpt-4o-mini', reasoning: 'high' })).rejects.toThrow();
    expect(bodies.map((body) => body.reasoning)).toEqual([{ effort: 'high' }, { max_tokens: 2000 }, undefined]);
    expect(bodies[0]!.model).toBe('deepseek/deepseek-r1');
  });
});

describe('reasoning returned and replayed (LOU-V13)', () => {
  const turn: Message = {
    role: 'assistant',
    content: '',
    reasoning: [{ text: 'I should look it up.', signature: 'sig-1' }, { text: '', redactedData: 'opaque' }],
    toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
  };
  const history: Message[] = [...user, turn, { role: 'tool', content: '"found"', toolCallId: 'call_1', toolName: 'lookup' }];

  it('ai v7: returns reasoning blocks with their signature, and sends them back first in the tool-call turn', async () => {
    const provider = new AnthropicProvider({ apiKey: 'k', maxRetries: 0 });
    const calls = onV7(
      provider,
      v7Result([
        { type: 'reasoning', text: 'Hmm.', providerMetadata: { anthropic: { signature: 'sig-2' } } },
        { type: 'text', text: 'ok' },
      ])
    );
    const result = await provider.generate({ messages: history, model: 'claude-sonnet-4-5' });

    expect(result.reasoning).toEqual([{ text: 'Hmm.', signature: 'sig-2' }]);
    expect(result.usage?.reasoningTokens).toBe(7);
    expect(result.text).toBe('ok');
    expect(calls[0]!.prompt[1]).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'I should look it up.', providerOptions: { anthropic: { signature: 'sig-1' } } },
        { type: 'reasoning', text: '', providerOptions: { anthropic: { redactedData: 'opaque' } } },
        { type: 'tool-call', toolCallId: 'call_1' },
      ],
    });
  });

  it('ai v7: other providers never send reasoning back', async () => {
    const provider = new OpenAIProvider({ apiKey: 'k', maxRetries: 0 });
    const calls = onV7(provider);
    await provider.generate({ messages: history, model: 'o3' });
    expect(calls[0]!.prompt[1]).toMatchObject({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_1' }] });
  });

  itOnAiV4('ai v4: returns reasoning details as blocks, and sends signed thinking back as reasoning parts', async () => {
    const provider = new AnthropicProvider({ apiKey: 'k', maxRetries: 0 });
    const calls = onV4(provider, [{ type: 'text', text: 'Hmm.', signature: 'sig-2' }]);
    const result = await provider.generate({ messages: history, model: 'claude-sonnet-4-5' });

    expect(result.reasoning).toEqual([{ text: 'Hmm.', signature: 'sig-2' }]);
    expect(calls[0]!.prompt[1]).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'I should look it up.', signature: 'sig-1' },
        { type: 'redacted-reasoning', data: 'opaque' },
        { type: 'tool-call', toolCallId: 'call_1' },
      ],
    });
  });
});

describe('image parts on ai v7 (LOU-V13 follow-up B)', () => {
  it('sends `file` parts with a media type, never the deprecated `image` part', async () => {
    const provider = new OpenAIProvider({ apiKey: 'k', maxRetries: 0 });
    const generateText = vi.fn(aiV7.generateText);
    const ai: AiSdkModule = { ...aiV7, generateText: generateText as AiSdkModule['generateText'] };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The model takes URLs itself, so nothing is downloaded.
    const supportedUrls = { 'image/*': [/^https:\/\//] };
    useModel(provider, new MockLanguageModelV4({ supportedUrls, doGenerate: async () => v7Result() }), ai);

    await provider.generate({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'What is it?' }, { type: 'image', image: 'https://example.com/cat.png' }, { type: 'image', image: new Uint8Array([1]), mimeType: 'image/png' }] }],
    });

    const sent = (generateText.mock.calls[0]![0] as { messages: Array<{ content: Array<{ type: string; mediaType?: string }> }> }).messages;
    expect(sent[0]!.content.map((part) => [part.type, part.mediaType])).toEqual([
      ['text', undefined],
      ['file', 'image/*'],
      ['file', 'image/png'],
    ]);
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/deprecated/);
  });
});
