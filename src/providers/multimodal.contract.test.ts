/**
 * Contract tests for multimodal message parts (LOU-V11): what each
 * 'ai'-SDK-backed provider hands the model (a mock language model of the
 * installed `ai` major, see aiShapes.testkit.ts) when a user message carries
 * image and file parts. Prompts are compared in one neutral shape on every
 * major (LOU-D28f): an image is an `image` part, a file a `file` part.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LanguageModel } from 'ai';
import * as aiV7 from 'ai-v7';
import { MockLanguageModelV4 } from 'ai-v7/test';
import type { AiSdkModule } from './aiSdkCompat';
import { installedAiMajor } from './aiMajor.testkit';
import { mockLanguageModel } from './aiShapes.testkit';
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
// Real PDF magic bytes: `ai` 5+ sniffs the media type from the bytes, so a PNG labelled a PDF would come out an image.
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3]);

const providers: Array<[string, () => LLMProvider]> = [
  ['openai', () => new OpenAIProvider({ name: 'openai', apiKey: 'k' })],
  ['anthropic', () => new AnthropicProvider({ name: 'anthropic', apiKey: 'k' })],
  ['ollama', () => new OllamaProvider({ name: 'ollama' })],
  ['openrouter', () => new OpenRouterProvider({ name: 'openrouter', apiKey: 'k' })],
];

/** Point a provider at a mock model of the installed major and capture the prompts it receives. */
function withMockModel(provider: LLMProvider, supportsImageUrls = false) {
  const { model, prompts } = mockLanguageModel({ supportsImageUrls });
  const target = provider as unknown as { createModel: (id: string) => Promise<LanguageModel> };
  vi.spyOn(target, 'createModel').mockResolvedValue(model);
  return { prompts };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(providers)('%s provider: multimodal user content (LOU-V11)', (_name, make) => {
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

  it('sends a file part as a text note on ai 4 and for Ollama, with one warning per media type', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = make();
    // The installed major decides: on ai 6/7 the OpenAI, Anthropic and OpenRouter providers send a PDF.
    const sendsPdf = installedAiMajor >= 6 && provider.name !== 'ollama';
    const { prompts } = withMockModel(provider);
    const file: Message = {
      role: 'user',
      content: [{ type: 'file', data: PDF, mimeType: 'application/pdf', filename: 'report.pdf' }],
    };

    await provider.generate({ messages: [file] });
    await provider.generate({ messages: [file] });

    if (sendsPdf) {
      expect(prompts[0][0]).toMatchObject({ role: 'user', content: [{ type: 'file', mediaType: 'application/pdf' }] });
      expect(warn).not.toHaveBeenCalled();
      return;
    }
    expect(prompts[0][0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: '[file report.pdf (application/pdf) not sent]' }],
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(
      `The ${provider.name} provider cannot send application/pdf file parts on ai ${installedAiMajor}; they are sent as a text note.`
    );
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

describe('file parts for a provider that accepts them (LOU-V11)', () => {
  it('maps a file part to a model file part', async () => {
    class FileProvider extends OpenAIProvider {
      protected readonly acceptsFileParts = true;
    }
    const provider = new FileProvider({ name: 'openai', apiKey: 'k' });
    const { prompts } = withMockModel(provider);

    await provider.generate({
      messages: [{ role: 'user', content: [{ type: 'file', data: PDF, mimeType: 'application/pdf', filename: 'a.pdf' }] }],
    });

    expect(prompts[0][0]).toEqual({
      role: 'user',
      content: [{ type: 'file', data: Buffer.from(PDF).toString('base64'), mimeType: 'application/pdf', filename: 'a.pdf' }],
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

/** A provider on `ai` 7 (the `ai-v7` alias) with a scripted `MockLanguageModelV4`, capturing the prompts it receives. */
function onAi7(provider: LLMProvider) {
  const prompts: unknown[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(options.prompt);
      return {
        content: [{ type: 'text', text: 'ok' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  Object.assign(provider, { ai: aiV7 as unknown as AiSdkModule });
  vi.spyOn(provider as unknown as { createModel: () => Promise<unknown> }, 'createModel').mockResolvedValue(model);
  return prompts as Array<Array<{ role: string; content: Array<Record<string, unknown>> }>>;
}

const fileMessage = (mimeType: string, data: Uint8Array = PDF): Message => ({
  role: 'user',
  content: [{ type: 'file', data, mimeType, filename: 'doc' }],
});

describe.each([
  ['openai', () => new OpenAIProvider({ name: 'openai', apiKey: 'k' }), false],
  ['anthropic', () => new AnthropicProvider({ name: 'anthropic', apiKey: 'k' }), true],
  ['openrouter', () => new OpenRouterProvider({ name: 'openrouter', apiKey: 'k' }), false],
] as const)('%s provider on ai 7: file parts', (_name, make, sendsPlainText) => {
  it('sends a PDF as a file part', async () => {
    const provider = make();
    const prompts = onAi7(provider);
    await provider.generate({ messages: [fileMessage('application/pdf')] });
    expect(prompts[0][0].content[0]).toMatchObject({ type: 'file', mediaType: 'application/pdf' });
  });

  it('sends an unsupported type as a text note, warning once per media type', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = make();
    const prompts = onAi7(provider);
    const xls = fileMessage('application/vnd.ms-excel', new Uint8Array([1, 2, 3]));
    await provider.generate({ messages: [xls] });
    await provider.generate({ messages: [xls] });
    expect(prompts[0][0].content[0]).toEqual({ type: 'text', text: '[file doc (application/vnd.ms-excel) not sent]' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(
      `The ${provider.name} provider cannot send application/vnd.ms-excel file parts on ai 7; they are sent as a text note.`
    );
  });

  it(`sends text/plain ${sendsPlainText ? 'as a file part' : 'as a text note'}`, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = make();
    const prompts = onAi7(provider);
    await provider.generate({ messages: [fileMessage('text/plain; charset=utf-8', new TextEncoder().encode('hello'))] });
    const part = prompts[0][0].content[0];
    if (sendsPlainText) expect(part).toMatchObject({ type: 'file' });
    else expect(part).toMatchObject({ type: 'text' });
  });
});

describe('ollama provider on ai 7: file parts', () => {
  it('sends a PDF as a text note', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = new OllamaProvider({ name: 'ollama' });
    const prompts = onAi7(provider);
    await provider.generate({ messages: [fileMessage('application/pdf')] });
    expect(prompts[0][0].content[0]).toMatchObject({ type: 'text', text: '[file doc (application/pdf) not sent]' });
  });
});
