/**
 * The 'ai'-SDK providers' generate() on `ai` v7 (LOU-D26): the scenarios of
 * toolCallTurns.contract.test.ts and multimodal.contract.test.ts, run
 * through the real `ai` v7 (installed as the `ai-v7` dev alias) and its
 * `MockLanguageModelV4`, by giving each provider that module instead of the
 * installed v4 one. Asserts what the model receives and what generate()
 * returns.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as aiV7 from 'ai-v7';
import { MockLanguageModelV4 } from 'ai-v7/test';
import { z } from 'zod';
import { OpenAIProvider } from './OpenAIProvider';
import { AnthropicProvider } from './AnthropicProvider';
import { OllamaProvider } from './OllamaProvider';
import { OpenRouterProvider } from './OpenRouterProvider';
import type { LLMProvider, Message } from './llm';
import { isModernAi, type AiSdkModule } from './aiSdkCompat';
import { installedAiMajor } from './aiMajor.testkit';
import { AgentExecutor } from '../execution/AgentExecutor';
import { AgentBuilder } from '../core';
import { ToolRegistry, defineTool } from '../tools';

type DoGenerate = MockLanguageModelV4['doGenerate'];
type CallOptions = Parameters<DoGenerate>[0];
type ModelResult = Awaited<ReturnType<DoGenerate>>;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1]);

const providers: Array<[string, () => LLMProvider]> = [
  ['openai', () => new OpenAIProvider({ name: 'openai', apiKey: 'k', maxRetries: 0 })],
  ['anthropic', () => new AnthropicProvider({ name: 'anthropic', apiKey: 'k', maxRetries: 0 })],
  ['ollama', () => new OllamaProvider({ name: 'ollama', maxRetries: 0 })],
  ['openrouter', () => new OpenRouterProvider({ name: 'openrouter', apiKey: 'k', maxRetries: 0 })],
];

function modelResult(overrides: Partial<ModelResult> = {}): ModelResult {
  return {
    content: [{ type: 'text', text: 'ok' }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 10, noCache: 6, cacheRead: 4, cacheWrite: undefined },
      outputTokens: { total: 5, text: 3, reasoning: 2 },
    },
    warnings: [],
    ...overrides,
  };
}

/** Run `provider` on `ai` v7 with a MockLanguageModelV4; returns the call options the model got. */
function onV7(provider: LLMProvider, results: ModelResult[] = [modelResult()], supportsUrls = false): CallOptions[] {
  const calls: CallOptions[] = [];
  const model = new MockLanguageModelV4({
    supportedUrls: supportsUrls ? { 'image/*': [/^https:\/\//] } : {},
    doGenerate: async (options) => {
      calls.push(options);
      return results[Math.min(calls.length - 1, results.length - 1)]!;
    },
  });
  const ai: AiSdkModule = aiV7;
  Object.assign(provider, { ai });
  const target = provider as unknown as { createModel: (id: string) => Promise<unknown> };
  vi.spyOn(target, 'createModel').mockResolvedValue(model);
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const history: Message[] = [
  { role: 'system', content: 'You report weather.' },
  { role: 'user', content: 'Weather in Paris and Rome?' },
  {
    role: 'assistant',
    content: 'Checking both cities.',
    toolCalls: [
      { id: 'call_A', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
      { id: 'call_B', type: 'function', function: { name: 'get_weather', arguments: '{not json' } },
    ],
  },
  { role: 'tool', content: '{"tempC":21,"sky":"clear"}', toolCallId: 'call_A', toolName: 'get_weather' },
  { role: 'tool', content: '{"error":"Error","message":"Rome station offline"}', toolCallId: 'call_B', isError: true },
  { role: 'tool', content: 'plain text', toolCallId: 'orphan' },
  { role: 'tool', content: 'offline', toolCallId: 'call_B', toolName: 'get_weather', isError: true },
];

describe('the compat layer detects the ai major', () => {
  it('treats ai v7 as modern, and the installed ai as modern only from v5 on', async () => {
    expect(isModernAi(aiV7)).toBe(true);
    // Agnostic (LOU-D28b): `ai` is v4 on the default install and v7 on the ai-7 CI job.
    expect(isModernAi(await import('ai'))).toBe(installedAiMajor >= 5);
  });
});

describe.each(providers)('%s provider on ai v7: generate() (LOU-D26)', (_name, make) => {
  it('sends tool-call turns as ModelMessages linked by id', async () => {
    const provider = make();
    const calls = onV7(provider);
    await provider.generate({ messages: history });

    // v7 merges consecutive tool messages into one.
    expect(calls[0]!.prompt).toMatchObject([
      { role: 'system', content: 'You report weather.' },
      { role: 'user', content: [{ type: 'text', text: 'Weather in Paris and Rome?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking both cities.' },
          { type: 'tool-call', toolCallId: 'call_A', toolName: 'get_weather', input: { city: 'Paris' } },
          { type: 'tool-call', toolCallId: 'call_B', toolName: 'get_weather', input: {} },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'call_A', toolName: 'get_weather', output: { type: 'json', value: { tempC: 21, sky: 'clear' } } },
          {
            type: 'tool-result',
            toolCallId: 'call_B',
            toolName: 'get_weather',
            output: { type: 'error-json', value: { error: 'Error', message: 'Rome station offline' } },
          },
          { type: 'tool-result', toolCallId: 'orphan', toolName: 'unknown', output: { type: 'text', value: 'plain text' } },
          { type: 'tool-result', toolCallId: 'call_B', toolName: 'get_weather', output: { type: 'error-text', value: 'offline' } },
        ],
      },
    ]);
  });

  it('maps tools, settings and responseFormat to the v7 call shape', async () => {
    const provider = make();
    const calls = onV7(provider);
    const schema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };

    await provider.generate({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 64,
      temperature: 0.2,
      topP: 0.9,
      seed: 7,
      tools: [
        { type: 'function', function: { name: 'zod_tool', description: 'Zod', parameters: z.object({ q: z.string() }) } },
        { type: 'function', function: { name: 'json_tool', description: 'JSON', parameters: schema } },
      ],
      responseFormat: { type: 'json', schema: { type: 'object' } },
    });

    expect(calls[0]).toMatchObject({
      maxOutputTokens: 64,
      temperature: 0.2,
      topP: 0.9,
      seed: 7,
      responseFormat: { type: 'json', schema: { type: 'object' } },
      tools: [
        { type: 'function', name: 'zod_tool', description: 'Zod', inputSchema: { properties: { q: { type: 'string' } } } },
        { type: 'function', name: 'json_tool', description: 'JSON', inputSchema: schema },
      ],
    });
  });

  it('normalizes text, tool calls, finish reason and usage', async () => {
    const provider = make();
    onV7(provider, [
      modelResult({
        content: [
          { type: 'text', text: 'Checking.' },
          { type: 'tool-call', toolCallId: 'call_A', toolName: 'get_weather', input: '{"city":"Paris"}' },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool_use' },
      }),
    ]);

    const result = await provider.generate({
      messages: [{ role: 'user', content: 'Weather?' }],
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'W', parameters: z.object({ city: z.string() }) } }],
    });

    expect(result).toMatchObject({
      text: 'Checking.',
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'call_A', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedInputTokens: 4, reasoningTokens: 2 },
    });
  });

  it('reports no usage when the model reports none, and leaves a JSON reply as text', async () => {
    const provider = make();
    onV7(provider, [
      modelResult({
        content: [{ type: 'text', text: '{"a":1}' }],
        finishReason: { unified: 'length', raw: undefined },
        usage: {
          inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: undefined, text: undefined, reasoning: undefined },
        },
      }),
    ]);

    const result = await provider.generate({ messages: [{ role: 'user', content: 'hi' }], responseFormat: { type: 'json' } });

    expect(result.text).toBe('{"a":1}');
    expect(result.finishReason).toBe('length');
    expect(result.usage).toBeUndefined();
    expect(result.toolCalls).toEqual([]);
  });

  it('forwards the abort signal to the model', async () => {
    const provider = make();
    const calls = onV7(provider);
    const controller = new AbortController();
    controller.abort();

    await provider.generate({ messages: [{ role: 'user', content: 'hi' }], signal: controller.signal });

    expect(calls[0]!.abortSignal?.aborted).toBe(true);
  });

  it('sends text and image parts (bytes and data URL), and an image URL to a model that takes URLs', async () => {
    const provider = make();
    const calls = onV7(provider, undefined, true);

    await provider.generate({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image', image: PNG, mimeType: 'image/png' },
            { type: 'image', image: `data:image/jpeg;base64,${Buffer.from([1, 2, 3]).toString('base64')}` },
            { type: 'image', image: 'https://example.com/cat.png' },
          ],
        },
      ],
    });

    expect(calls[0]!.prompt[0]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'What is this?' },
        { type: 'file', mediaType: 'image/png' },
        { type: 'file', mediaType: 'image/jpeg' },
        // LOU-V13 (D-follow-up): sent as a `file` part, not the deprecated `image` part; `image/*` when the type is unknown.
        { type: 'file', mediaType: 'image/*', data: { type: 'url', url: new URL('https://example.com/cat.png') } },
      ],
    });
  });

  it('sends a file part as a text note, and the text of system and assistant parts', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = make();
    const calls = onV7(provider);

    await provider.generate({
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'Be brief.' }] },
        { role: 'user', content: [{ type: 'file', data: PNG, mimeType: 'application/pdf', filename: 'report.pdf' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Hello' }, { type: 'image', image: PNG }] },
      ],
    });

    expect(calls[0]!.prompt).toMatchObject([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: [{ type: 'text', text: '[file report.pdf (application/pdf) not sent]' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
    ]);
  });
});

describe('file parts for a provider that accepts them, on ai v7', () => {
  it('maps a file part to the v7 FilePart', async () => {
    class FileProvider extends OpenAIProvider {
      protected readonly acceptsFileParts = true;
    }
    const provider = new FileProvider({ name: 'openai', apiKey: 'k' });
    const calls = onV7(provider);

    await provider.generate({
      messages: [{ role: 'user', content: [{ type: 'file', data: PDF, mimeType: 'application/pdf', filename: 'a.pdf' }] }],
    });

    expect(calls[0]!.prompt[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'file', mediaType: 'application/pdf', filename: 'a.pdf', data: { type: 'data' } }],
    });
  });
});

describe('AgentExecutor on ai v7 (LOU-D26)', () => {
  it.each(providers)('%s: runs a tool loop, and the second call sees the first call tool turn', async (_name, make) => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(
      defineTool({
        name: 'get_weather',
        description: 'Weather for a city',
        input: z.object({ city: z.string() }),
        execute: async ({ city }) => ({ city, tempC: 21 }),
      })
    );
    const agent = AgentBuilder.create()
      .setName('Weather')
      .addTool('get_weather', { tool: 'get_weather', options: {} })
      .build();
    const provider = make();
    const calls = onV7(provider, [
      modelResult({
        content: [{ type: 'tool-call', toolCallId: 'call_A', toolName: 'get_weather', input: '{"city":"Paris"}' }],
        finishReason: { unified: 'tool-calls', raw: undefined },
      }),
      modelResult({ content: [{ type: 'text', text: 'Paris is 21C.' }] }),
    ]);

    const result = await AgentExecutor.execute({ agent, input: 'Weather in Paris?', provider, toolRegistry });

    expect(result.text).toBe('Paris is 21C.');
    expect(calls[1]!.prompt.slice(-2)).toMatchObject([
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_A', toolName: 'get_weather', input: { city: 'Paris' } }] },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'call_A', toolName: 'get_weather', output: { type: 'json', value: { city: 'Paris', tempC: 21 } } }],
      },
    ]);
  });
});
