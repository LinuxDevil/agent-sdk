/**
 * Offline tests for the `pi` provider (H2): the scripted backend is pi's own
 * faux provider (`registerFauxProvider` from `@earendil-works/pi-ai/compat`),
 * injected through `PiProviderConfig.models` - no hand-rolled mocks.
 *
 * Covers the provider conformance surface `pi` must satisfy: generate,
 * stream (and its chunk ordering), text, tool calls and tool results (as
 * sent on the wire and as run by AgentExecutor), reasoning blocks, usage,
 * multimodal mapping, registration/resolution, and fallback.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import {
  registerFauxProvider,
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type FauxProviderRegistration,
} from '@earendil-works/pi-ai/compat';
import { PiProvider, type PiProviderConfig } from './PiProvider';
import { createAgent } from '../../createAgent';
import { defineTool } from '../../tools/defineTool';
import { resolveProvider } from '../resolveProvider';
import { LLMProviderRegistry, type Message, type StreamChunk } from '../llm';
import { withFallback } from '../resilience';
import { MockLLMProvider } from '../mock';
import { getModelInfo } from '../../models/registry';
import type { AgentEvent } from '../../execution/agentEvents';
import type { PiMessage } from './piTypes';

const MODEL_SPEC = 'faux/faux-1';

let registration: FauxProviderRegistration | undefined;

/** A fresh faux provider registration (fresh api id, empty response queue). */
function fauxRegister(): FauxProviderRegistration {
  return registerFauxProvider({
    provider: 'faux',
    models: [
      { id: 'faux-1', reasoning: true, input: ['text', 'image'], cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 } },
    ] as never,
  });
}

function provider(config: PiProviderConfig = {}): PiProvider {
  registration ??= fauxRegister();
  return new PiProvider({ models: registration.models as unknown as PiProviderConfig['models'], defaultModel: MODEL_SPEC, ...config });
}

afterEach(() => {
  registration?.unregister();
  registration = undefined;
});

describe('PiProvider (faux backend)', () => {
  it('generate() returns the scripted text with usage', async () => {
    registration = fauxRegister();
    registration.setResponses([fauxAssistantMessage('Hello from pi.')]);
    const result = await provider().generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.text).toBe('Hello from pi.');
    expect(result.finishReason).toBe('stop');
    // The faux provider estimates usage from the transcript: non-zero.
    expect(result.usage?.promptTokens).toBeGreaterThan(0);
    expect(result.usage?.completionTokens).toBeGreaterThan(0);
  });

  it('stream() yields text-delta chunks then a finish chunk with usage', async () => {
    registration = fauxRegister();
    registration.setResponses([fauxAssistantMessage('streamed answer')]);
    const result = await provider().stream({ messages: [{ role: 'user', content: 'hi' }] });
    const types: string[] = [];
    for await (const chunk of result.fullStream) {
      types.push(chunk.type);
      expect(chunk.type).not.toBe('error');
    }
    expect(types[0]).toBe('text-delta');
    expect(types[types.length - 1]).toBe('finish');
    expect(await result.text).toBe('streamed answer');
    const usage = await result.usage;
    expect(usage?.promptTokens).toBeGreaterThan(0);
    expect(await result.finishReason).toBe('stop');
  });

  it('maps tool calls out and tool results back into the transcript', async () => {
    registration = fauxRegister();
    let secondCall: PiMessage[] | undefined;
    registration.setResponses([
      fauxAssistantMessage([fauxToolCall('read_file', { path: 'math.js' }, { id: 'call_1' })]),
      (context) => {
        secondCall = context.messages as unknown as PiMessage[];
        return fauxAssistantMessage('got it');
      },
    ]);
    const p = provider();
    const first = await p.generate({
      messages: [{ role: 'user', content: 'read math.js' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read a file',
            parameters: z.object({ path: z.string().describe('path') }),
          },
        },
      ],
    });
    expect(first.finishReason).toBe('tool_calls');
    expect(first.toolCalls).toEqual([{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"math.js"}' } }]);

    const history: Message[] = [
      { role: 'user', content: 'read math.js' },
      { role: 'assistant', content: '', toolCalls: first.toolCalls },
      { role: 'tool', toolCallId: 'call_1', toolName: 'read_file', content: '{"ok":true}' },
    ];
    const second = await p.generate({ messages: history });
    expect(second.text).toBe('got it');
    // The history pi saw: the assistant turn carries a toolCall part; the
    // result is a toolResult message linked by id.
    const assistant = secondCall?.find((m) => m.role === 'assistant');
    const toolResult = secondCall?.find((m) => m.role === 'toolResult');
    expect(assistant?.content.some((part) => part.type === 'toolCall' && part.id === 'call_1' && part.name === 'read_file')).toBe(true);
    const call = assistant?.content.find((part) => part.type === 'toolCall');
    expect(call?.type === 'toolCall' ? call.arguments : undefined).toEqual({ path: 'math.js' });
    expect(toolResult).toMatchObject({ toolCallId: 'call_1', toolName: 'read_file', isError: false });
  });

  it('streams reasoning deltas and a reasoning-end with the signature', async () => {
    registration = fauxRegister();
    registration.setResponses([fauxAssistantMessage([fauxThinking('thinking hard'), fauxText('done')])]);
    const result = await provider().stream({ messages: [{ role: 'user', content: 'think' }] });
    const types: string[] = [];
    for await (const chunk of result.fullStream) types.push(chunk.type);
    expect(types).toContain('reasoning-delta');
    expect(types).toContain('reasoning-end');
    expect(types.indexOf('reasoning-delta')).toBeLessThan(types.indexOf('text-delta'));
  });

  it('reports reasoning blocks on generate()', async () => {
    registration = fauxRegister();
    registration.setResponses([fauxAssistantMessage([fauxThinking('hmm'), fauxText('answer')])]);
    const result = await provider().generate({ messages: [{ role: 'user', content: 'think' }] });
    expect(result.reasoning).toEqual([{ text: 'hmm' }]);
  });

  it('maps image parts to pi image content and degrades file parts to text notes', async () => {
    registration = fauxRegister();
    let seen: PiMessage[] | undefined;
    registration.setResponses([
      (context) => {
        seen = context.messages as unknown as PiMessage[];
        return fauxAssistantMessage('ok');
      },
    ]);
    const imageBytes = new Uint8Array([137, 80, 78, 71]);
    await provider().generate({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe' },
            { type: 'image', image: imageBytes, mimeType: 'image/png' },
            { type: 'image', image: 'data:image/gif;base64,R0lGODdh' },
            { type: 'file', data: 'aGVsbG8=', mimeType: 'application/pdf', filename: 'doc.pdf' },
          ],
        },
      ],
    });
    const content = (seen?.find((m) => m.role === 'user') as { content?: unknown[] } | undefined)?.content;
    expect(content?.[0]).toEqual({ type: 'text', text: 'describe' });
    expect(content?.[1]).toEqual({ type: 'image', mimeType: 'image/png', data: Buffer.from(imageBytes).toString('base64') });
    expect(content?.[2]).toEqual({ type: 'image', mimeType: 'image/gif', data: 'R0lGODdh' });
    expect(content?.[3]).toMatchObject({ type: 'text' });
    expect((content?.[3] as { text: string }).text).toContain('doc.pdf');
  });

  it('pins pi retries off (Lousho withRetry() is the only retry layer)', async () => {
    registration = fauxRegister();
    let seenMaxRetries: unknown;
    registration.setResponses([
      (_context, options) => {
        seenMaxRetries = (options as { maxRetries?: number } | undefined)?.maxRetries;
        return fauxAssistantMessage('ok');
      },
    ]);
    await provider().generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(seenMaxRetries).toBe(0);
  });

  it('throws a coded error for a malformed or unknown nested spec', async () => {
    registration = fauxRegister();
    const p = provider();
    await expect(p.generate({ model: 'noslash', messages: [] })).rejects.toMatchObject({ code: 'LOUSHO_PROVIDER_SPEC_INVALID' });
    await expect(p.generate({ model: 'faux/does-not-exist', messages: [] })).rejects.toMatchObject({ code: 'LOUSHO_PROVIDER_UNKNOWN' });
    await expect(p.generate({ model: 'not-a-provider/x', messages: [] })).rejects.toMatchObject({ code: 'LOUSHO_PROVIDER_UNKNOWN' });
  });

  it('reports a stream error chunk when the scripted queue is empty', async () => {
    registration = fauxRegister(); // no responses queued
    const result = await provider().stream({ messages: [{ role: 'user', content: 'hi' }] });
    const chunks: StreamChunk[] = [];
    for await (const chunk of result.fullStream) chunks.push(chunk);
    expect(chunks[0]?.type).toBe('error');
    expect(String(chunks[0]?.error?.message)).toContain('No more faux responses queued');
  });

  it('lists the injected catalog models from getModels()', async () => {
    registration = fauxRegister();
    expect(await provider().getModels()).toContain('faux/faux-1');
  });

  it('registers catalog pricing so runs price the model', async () => {
    registration = fauxRegister();
    registration.setResponses([fauxAssistantMessage('ok')]);
    await provider().generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(getModelInfo('pi/faux/faux-1')?.inputCostPerMTok).toBe(1);
  });
});

describe('pi provider registration and agent wiring', () => {
  it('LLMProviderRegistry.create() resolves the built-in pi factory', () => {
    expect(LLMProviderRegistry.create('pi', { defaultModel: 'faux/faux-1' })).toBeInstanceOf(PiProvider);
  });

  it('resolveProvider() accepts the pi/<provider>/<model> spec', () => {
    const p = resolveProvider('pi/openrouter/openai/gpt-4o-mini');
    expect(p).toBeInstanceOf(PiProvider);
    expect(p.name).toBe('pi');
    expect(p.defaultModel).toBe('openrouter/openai/gpt-4o-mini');
  });

  it('a createAgent() run over faux drives tool calls and reports usage + costUsd', async () => {
    registration = fauxRegister();
    const seenArgs: unknown[] = [];
    const readFile = defineTool({
      name: 'read_file',
      description: 'Read a file',
      input: z.object({ path: z.string() }),
      execute: (args) => {
        seenArgs.push(args);
        return { content: 'file body' };
      },
    });
    registration.setResponses([
      fauxAssistantMessage([fauxToolCall('read_file', { path: 'a.txt' })]),
      fauxAssistantMessage('The file says: file body'),
    ]);
    const agent = createAgent({ provider: provider(), tools: [readFile] });
    const result = await agent.send('read a.txt');
    expect(result.finishReason).toBe('stop');
    expect(result.text).toContain('file body');
    expect(seenArgs).toEqual([{ path: 'a.txt' }]);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.usage.modelCalls).toBe(2);
    // The faux model's catalog cost was registered: the run prices it.
    expect(result.usage.costUsd).toBeGreaterThan(0);
  });

  it('agent.stream() emits the standard event sequence', async () => {
    registration = fauxRegister();
    registration.setResponses([fauxAssistantMessage('streamed')]);
    const agent = createAgent({ provider: provider() });
    const types: string[] = [];
    for await (const event of agent.stream('hi')) types.push(event.type);
    expect(types[0]).toBe('run.start');
    expect(types).toContain('step.start');
    expect(types).toContain('text.delta');
    expect(types[types.length - 1]).toBe('run.done');
  });

  it('falls back to the next provider on a bad pi model and emits provider.fallback', async () => {
    registration = fauxRegister();
    const events: AgentEvent[] = [];
    const agent = createAgent({
      provider: withFallback([provider({ defaultModel: 'faux/no-such-model' }), new MockLLMProvider({ responses: ['fallback answer'] })]),
      onEvent: (event) => events.push(event),
    });
    const result = await agent.send('hi');
    expect(result.text).toBe('fallback answer');
    const fallback = events.find((e) => e.type === 'provider.fallback');
    expect(fallback).toMatchObject({ from: 'pi', to: 'mock' });
  });
});
