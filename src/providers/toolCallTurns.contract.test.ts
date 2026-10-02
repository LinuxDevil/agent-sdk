/**
 * Contract tests at the 'ai'-SDK boundary for tool-call conversations
 * (LOU-U2).
 *
 * Mocks the 'ai' SDK's generateText (no live API key required) and asserts
 * the exact `messages` payload every 'ai'-SDK-backed provider hands it for a
 * two-step tool conversation: the assistant's tool-call turn must survive as
 * `tool-call` content parts, and each tool result must be a `tool-result`
 * part whose toolCallId/toolName match. The payload is also run through the
 * installed 'ai' version's own `coreMessageSchema`, which strips unknown
 * keys - so a payload that survives that parse unchanged is exactly what
 * 'ai' forwards to the provider.
 *
 * Runs on every `ai` major (LOU-D28f): the parts `ai` takes differ between
 * v4 (`args`, `result`) and v5+ (`input`, a typed `output`), so the expected
 * payloads are built with aiShapes.testkit.ts, and the schema check uses the
 * installed major's own message schema.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import { installedAiMajor, ollamaV2Installed } from './aiMajor.testkit';
import { aiTool, mockToolCall, mockUsage, parseModelMessage, toolCallPart, toolResultPart } from './aiShapes.testkit';

const generateTextMock = vi.fn();

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return {
    ...actual,
    generateText: (...args: unknown[]) => generateTextMock(...args),
  };
});

import { OpenAIProvider } from './OpenAIProvider';
import { AnthropicProvider } from './AnthropicProvider';
import { OllamaProvider } from './OllamaProvider';
import { OpenRouterProvider } from './OpenRouterProvider';
import type { LLMProvider, Message } from './llm';
import type { LanguageModel } from 'ai';
import type { Checkpoint } from '../execution/checkpoint';
import { AgentExecutor } from '../execution/AgentExecutor';
import { ToolRegistry } from '../tools';
import { AgentBuilder } from '../core';

const usage = mockUsage();

/** A message as the payload `ai` receives it. */
type Payload = Array<{ role: string; content: unknown }>;

/** What each provider must hand `ai`: every message accepted by the installed `ai`'s own schema, nothing dropped. */
function expectAccepted(payload: unknown): void {
  expect((payload as Payload).map(parseModelMessage)).toEqual(payload);
}

function textResult(text = 'ok') {
  return { text, finishReason: 'stop', usage, toolCalls: [] };
}

/**
 * `generateText` is mocked, so the model is never called. On `ai` 6/7 the Ollama package
 * (`ollama-ai-provider-v2`, zod 4 peer) is installed only in the zod 4 CI jobs (LOU-M8); without it
 * the model is a stand-in.
 */
function ollama(): LLMProvider {
  const provider = new OllamaProvider({ name: 'ollama' });
  if (installedAiMajor !== 4 && !ollamaV2Installed) {
    const target = provider as unknown as { createModel: () => Promise<LanguageModel> };
    vi.spyOn(target, 'createModel').mockResolvedValue({} as LanguageModel);
  }
  return provider;
}

const providers: Array<[string, () => LLMProvider]> = [
  ['openai', () => new OpenAIProvider({ name: 'openai', apiKey: 'k' })],
  ['anthropic', () => new AnthropicProvider({ name: 'anthropic', apiKey: 'k' })],
  ['ollama', ollama],
  ['openrouter', () => new OpenRouterProvider({ name: 'openrouter', apiKey: 'k' })],
];

/**
 * user -> assistant(tool call A, tool call B) -> tool result A ->
 * tool result B (an error) -> assistant text -> user, in the exact internal
 * shape AgentExecutor.runToolCalls() appends.
 */
const history: Message[] = [
  { role: 'user', content: 'Weather in Paris and Rome?' },
  {
    role: 'assistant',
    content: 'Checking both cities.',
    toolCalls: [
      { id: 'call_A', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
      { id: 'call_B', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Rome"}' } },
    ],
  },
  {
    role: 'tool',
    content: '{"tempC":21,"sky":"clear"}',
    name: 'get_weather',
    toolCallId: 'call_A',
    toolName: 'get_weather',
  },
  {
    role: 'tool',
    content: '{"error":"Error","toolName":"get_weather","message":"Rome station offline","kind":"execution"}',
    name: 'get_weather',
    toolCallId: 'call_B',
    toolName: 'get_weather',
    isError: true,
  },
  { role: 'assistant', content: 'Paris is 21C and clear; Rome is unavailable.' },
  { role: 'user', content: 'Thanks!' },
];

const expectedPayload: Payload = [
  { role: 'user', content: 'Weather in Paris and Rome?' },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Checking both cities.' },
      toolCallPart('call_A', 'get_weather', { city: 'Paris' }),
      toolCallPart('call_B', 'get_weather', { city: 'Rome' }),
    ],
  },
  {
    role: 'tool',
    content: [
      toolResultPart('call_A', 'get_weather', { tempC: 21, sky: 'clear' }),
    ],
  },
  {
    role: 'tool',
    content: [
      toolResultPart(
        'call_B',
        'get_weather',
        { error: 'Error', toolName: 'get_weather', message: 'Rome station offline', kind: 'execution' },
        true
      ),
    ],
  },
  { role: 'assistant', content: 'Paris is 21C and clear; Rome is unavailable.' },
  { role: 'user', content: 'Thanks!' },
];

/** Send `messages` through the provider and return what generateText got. */
async function wirePayload(provider: LLMProvider, messages: Message[]): Promise<unknown> {
  generateTextMock.mockResolvedValue(textResult());
  await provider.generate({ model: 'm', messages });
  return generateTextMock.mock.calls[0][0].messages;
}

describe.each(providers)('%s provider: tool-call turns at the ai-SDK boundary', (_name, create) => {
  beforeEach(() => {
    generateTextMock.mockReset();
  });

  it('keeps the assistant tool-call turn and links every tool result to it', async () => {
    const payload = await wirePayload(create(), history);

    expect(payload).toEqual(expectedPayload);
    // The installed 'ai' version accepts it, dropping nothing.
    expectAccepted(payload);
  });

  it('converts a history restored from a checkpoint identically', async () => {
    const checkpoint: Checkpoint = {
      agentId: 'a',
      sessionId: 's',
      stepIndex: 2,
      messages: history,
      toolCalls: [],
      usage,
    };
    // Checkpoint stores round-trip through JSON (LocalStorageCheckpointStore,
    // agent-forge's FileCheckpointStore, the Worker's KV store).
    const restored = JSON.parse(JSON.stringify(checkpoint)) as Checkpoint;

    expect(await wirePayload(create(), restored.messages)).toEqual(expectedPayload);
  });

  it('sends a tool-call turn with no text as tool-call parts only', async () => {
    const payload = await wirePayload(create(), [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'now', arguments: '{}' } }],
      },
      { role: 'tool', content: '"2026-10-01"', toolCallId: 'c1', toolName: 'now' },
    ]);

    expect(payload).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [toolCallPart('c1', 'now', {})] },
      { role: 'tool', content: [toolResultPart('c1', 'now', '2026-10-01')] },
    ]);
    expectAccepted(payload);
  });

  it('passes non-JSON and non-string tool results through as-is', async () => {
    const objectContent = { rows: [1, 2] } as unknown as string;
    const payload = (await wirePayload(create(), [
      { role: 'tool', content: 'plain text', toolCallId: 'c1', toolName: 't' },
      { role: 'tool', content: objectContent, toolCallId: 'c2', toolName: 't' },
    ])) as Payload;

    expect(payload.map((m) => m.content)).toEqual([
      [toolResultPart('c1', 't', 'plain text')],
      [toolResultPart('c2', 't', { rows: [1, 2] })],
    ]);
  });

  it('recovers a missing tool name from the matching tool call, and survives bad JSON args', async () => {
    const payload = (await wirePayload(create(), [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{not json' } }],
      },
      { role: 'tool', content: '1', toolCallId: 'c1' },
      { role: 'tool', content: '2', toolCallId: 'orphan' },
    ])) as Payload;

    expect(payload).toEqual([
      { role: 'assistant', content: [toolCallPart('c1', 'search', {})] },
      { role: 'tool', content: [toolResultPart('c1', 'search', 1)] },
      { role: 'tool', content: [toolResultPart('orphan', 'unknown', 2)] },
    ]);
  });
});

describe('AgentExecutor -> provider: second step sees the first step tool calls', () => {
  beforeEach(() => {
    generateTextMock.mockReset();
  });

  it.each(providers)('%s', async (_name, create) => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register('get_weather', {
      displayName: 'Get weather',
      tool: aiTool({
        description: 'Weather for a city',
        schema: z.object({ city: z.string() }),
        execute: async ({ city }: { city: string }) => {
          if (city === 'Rome') throw new Error('Rome station offline');
          return { tempC: 21, sky: 'clear' };
        },
      }),
    });
    const agent = AgentBuilder.create()
      .setName('Weather')
      .addTool('get_weather', { tool: 'get_weather', options: {} })
      .build();

    generateTextMock
      .mockResolvedValueOnce({
        text: 'Checking both cities.',
        finishReason: 'tool-calls',
        usage,
        toolCalls: [
          mockToolCall('call_A', 'get_weather', { city: 'Paris' }),
          mockToolCall('call_B', 'get_weather', { city: 'Rome' }),
        ],
      })
      .mockResolvedValueOnce(textResult('Paris is 21C and clear; Rome is unavailable.'));

    const result = await AgentExecutor.execute({
      agent,
      input: 'Weather in Paris and Rome?',
      provider: create(),
      toolRegistry,
    });

    expect(result.text).toBe('Paris is 21C and clear; Rome is unavailable.');
    const secondCall = generateTextMock.mock.calls[1][0].messages as Payload;
    const fromUser = secondCall.slice(secondCall.findIndex((m) => m.role === 'user'));
    expect(fromUser).toEqual(expectedPayload.slice(0, 4));
  });
});
