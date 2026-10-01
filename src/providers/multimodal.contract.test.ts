/**
 * Contract tests for multimodal message parts (LOU-V11): what each
 * 'ai'-SDK-backed provider hands the model (an 'ai' v4 MockLanguageModelV1)
 * when a user message carries image and file parts.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LanguageModel, LanguageModelV1CallOptions } from 'ai';
import { MockLanguageModelV1 } from 'ai/test';
import { describeOnAiV4 } from './aiMajor.testkit';
import { OpenAIProvider } from './OpenAIProvider';
import { AnthropicProvider } from './AnthropicProvider';
import { OllamaProvider } from './OllamaProvider';
import { OpenRouterProvider } from './OpenRouterProvider';
import type { LLMProvider, Message } from './llm';
import { textOf } from './content';
import { AgentExecutor } from '../execution/AgentExecutor';
import { AgentBuilder } from '../core';
import { mockModel } from '../testing';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const providers: Array<[string, () => LLMProvider]> = [
  ['openai', () => new OpenAIProvider({ name: 'openai', apiKey: 'k' })],
  ['anthropic', () => new AnthropicProvider({ name: 'anthropic', apiKey: 'k' })],
  ['ollama', () => new OllamaProvider({ name: 'ollama' })],
  ['openrouter', () => new OpenRouterProvider({ name: 'openrouter', apiKey: 'k' })],
];

/** Point a provider at a MockLanguageModelV1 and capture the prompt it receives. */
function withMockModel(provider: LLMProvider, supportsUrl = false): { prompts: LanguageModelV1CallOptions['prompt'][] } {
  const prompts: LanguageModelV1CallOptions['prompt'][] = [];
  const model = new MockLanguageModelV1({
    supportsUrl: () => supportsUrl,
    doGenerate: async (options) => {
      prompts.push(options.prompt);
      return {
        text: 'a cat',
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 2 },
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });
  const target = provider as unknown as { createModel: (id: string) => Promise<LanguageModel> };
  vi.spyOn(target, 'createModel').mockResolvedValue(model);
  return { prompts };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// v4 only: asserts the ai v4 message shapes (LOU-D28b); the v7 shapes of these scenarios are asserted in aiSdkCompat.v7.test.ts.
describeOnAiV4.each(providers)('%s provider: multimodal user content (LOU-V11)', (_name, make) => {
  it('sends text and image parts (bytes and data URL) to the model', async () => {
    const provider = make();
    const { prompts } = withMockModel(provider);
    const messages: Message[] = [
      { role: 'system', content: 'You describe images.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image', image: PNG, mimeType: 'image/png' },
          { type: 'image', image: `data:image/jpeg;base64,${Buffer.from([1, 2, 3]).toString('base64')}` },
        ],
      },
    ];

    const result = await provider.generate({ messages });

    expect(result.text).toBe('a cat');
    expect(prompts[0]).toEqual([
      { role: 'system', content: 'You describe images.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image', image: PNG, mimeType: 'image/png' },
          { type: 'image', image: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' },
        ],
      },
    ]);
  });

  it('passes an image URL through to a model that takes URLs', async () => {
    const provider = make();
    const { prompts } = withMockModel(provider, true);

    await provider.generate({
      messages: [{ role: 'user', content: [{ type: 'image', image: 'https://example.com/cat.png' }] }],
    });

    expect(prompts[0][0]).toEqual({
      role: 'user',
      content: [{ type: 'image', image: new URL('https://example.com/cat.png') }],
    });
  });

  it('sends a file part as a text note, with one warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = make();
    const { prompts } = withMockModel(provider);
    const file: Message = {
      role: 'user',
      content: [{ type: 'file', data: PNG, mimeType: 'application/pdf', filename: 'report.pdf' }],
    };

    await provider.generate({ messages: [file] });
    await provider.generate({ messages: [file] });

    expect(prompts[0][0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: '[file report.pdf (application/pdf) not sent]' }],
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(`The ${provider.name} provider cannot send file parts`);
  });

  it('sends the text parts of assistant and system messages', async () => {
    const provider = make();
    const { prompts } = withMockModel(provider);

    await provider.generate({
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'Be brief.' }] },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'text', text: 'Hello' }, { type: 'image', image: PNG }] },
        { role: 'user', content: 'again' },
      ],
    });

    expect(prompts[0]).toMatchObject([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'user', content: [{ type: 'text', text: 'again' }] },
    ]);
  });
});

// v4 only: asserts the ai v4 message shapes (LOU-D28b); the v7 shapes of these scenarios are asserted in aiSdkCompat.v7.test.ts.
describeOnAiV4('file parts for a provider that accepts them (LOU-V11)', () => {
  it('maps a file part to the ai v4 FilePart', async () => {
    class FileProvider extends OpenAIProvider {
      protected readonly acceptsFileParts = true;
    }
    const provider = new FileProvider({ name: 'openai', apiKey: 'k' });
    const { prompts } = withMockModel(provider);

    await provider.generate({
      messages: [{ role: 'user', content: [{ type: 'file', data: PNG, mimeType: 'application/pdf', filename: 'a.pdf' }] }],
    });

    expect(prompts[0][0]).toEqual({
      role: 'user',
      content: [{ type: 'file', data: Buffer.from(PNG).toString('base64'), mimeType: 'application/pdf', filename: 'a.pdf' }],
    });
  });
});

describe('textOf (LOU-V11)', () => {
  it('returns a string as is and concatenates text parts', () => {
    expect(textOf('plain')).toBe('plain');
    expect(textOf({ content: 'plain' })).toBe('plain');
    expect(
      textOf({
        content: [
          { type: 'text', text: 'a ' },
          { type: 'image', image: PNG },
          { type: 'text', text: 'b' },
          { type: 'file', data: 'https://example.com/a.pdf', mimeType: 'application/pdf' },
        ],
      })
    ).toBe('a b');
  });
});

describe('AgentExecutor with multimodal input messages (LOU-V11)', () => {
  it('hands the image part to the provider unchanged', async () => {
    const model = mockModel(['A cat.']);
    const agent = AgentBuilder.create().setName('vision').setPrompt('Describe images.').build();
    const input: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image', image: PNG, mimeType: 'image/png' }] },
    ];

    const result = await AgentExecutor.execute({ agent, input, provider: model });

    expect(result.text).toBe('A cat.');
    expect(model.lastCall?.messages.at(-1)).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'What is this?' }, { type: 'image', image: PNG, mimeType: 'image/png' }],
    });
  });
});
