/**
 * M2: `fromAiSdk(model)` - an AI SDK language model as `createAgent`'s
 * provider. The installed `ai` 4 runs a `MockLanguageModelV1`; `ai` 7 (the
 * `ai-v7` dev alias, through the internal `createFromAiSdk()`) runs a
 * `MockLanguageModelV4`. Both script the same tool loop: a call to `add`,
 * then the answer.
 */

import { describe, expect, it } from 'vitest';
import * as aiV7 from 'ai-v7';
import { MockLanguageModelV4 } from 'ai-v7/test';
import { MockLanguageModelV1 } from 'ai/test';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import type { LLMProvider } from './llm';
import type { AiSdkModule } from './aiSdkCompat';
import { itOnAiV4 } from './aiMajor.testkit';
import { createFromAiSdk, fromAiSdk } from './fromAiSdk';
import { withFallback } from './resilience';
import * as root from '../index';

type V7Generate = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
type V7Options = Parameters<MockLanguageModelV4['doGenerate']>[0];
type V7Stream = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'];
type V7Part = V7Stream extends ReadableStream<infer P> ? P : never;
type V4Generate = Awaited<ReturnType<MockLanguageModelV1['doGenerate']>>;
type V4Stream = Awaited<ReturnType<MockLanguageModelV1['doStream']>>['stream'];
type V4Part = V4Stream extends ReadableStream<infer P> ? P : never;

const ADD_INPUT = '{"a":2,"b":3}';
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1]);

function streamOf<P>(parts: P[]): ReadableStream<P> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

/** `add`, counting its runs. */
function addTool() {
  const runs: Array<{ a: number; b: number }> = [];
  const tool = defineTool({
    name: 'add',
    description: 'Adds two numbers',
    input: z.object({ a: z.number(), b: z.number() }),
    execute: (input) => (runs.push(input), String(input.a + input.b)),
  });
  return { tool, runs };
}

const v7Usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: undefined },
  outputTokens: { total: 3, text: 3, reasoning: 0 },
};

/** An `ai` 7 model whose first call asks for `add` and whose later calls answer `5`. */
function v7Model(provider?: string) {
  const calls: V7Options[] = [];
  const generate: V7Generate[] = [
    {
      content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'add', input: ADD_INPUT }],
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
      usage: v7Usage,
      warnings: [],
    },
    { content: [{ type: 'text', text: 'The sum is 5.' }], finishReason: { unified: 'stop', raw: 'stop' }, usage: v7Usage, warnings: [] },
  ];
  const stream: V7Part[][] = [
    [
      { type: 'stream-start', warnings: [] },
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'add', input: ADD_INPUT },
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: v7Usage },
    ],
    [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'The sum ' },
      { type: 'text-delta', id: 't1', delta: 'is 5.' },
      { type: 'text-end', id: 't1' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: v7Usage },
    ],
  ];
  const step = <T>(script: T[]) => script[Math.min(calls.length - 1, script.length - 1)]!;
  const model = new MockLanguageModelV4({
    ...(provider !== undefined && { provider }),
    modelId: 'gemini-test',
    doGenerate: async (options) => (calls.push(options), step(generate)),
    doStream: async (options) => (calls.push(options), { stream: streamOf(step(stream)) }),
  });
  return { model, calls };
}

/** The same script as an `ai` 4 (`v1`) model. */
function v4Model() {
  let call = 0;
  const rawCall = { rawPrompt: null, rawSettings: {} };
  const usage = { promptTokens: 5, completionTokens: 3 };
  const generate: V4Generate[] = [
    { toolCalls: [{ toolCallType: 'function', toolCallId: 'call_1', toolName: 'add', args: ADD_INPUT }], finishReason: 'tool-calls', usage, rawCall },
    { text: 'The sum is 5.', finishReason: 'stop', usage, rawCall },
  ];
  const stream: V4Part[][] = [
    [
      { type: 'tool-call', toolCallType: 'function', toolCallId: 'call_1', toolName: 'add', args: ADD_INPUT },
      { type: 'finish', finishReason: 'tool-calls', usage },
    ],
    [
      { type: 'text-delta', textDelta: 'The sum ' },
      { type: 'text-delta', textDelta: 'is 5.' },
      { type: 'finish', finishReason: 'stop', usage },
    ],
  ];
  const step = <T>(script: T[]) => script[Math.min(call++, script.length - 1)]!;
  const model = new MockLanguageModelV1({
    provider: 'mock.v1',
    modelId: 'gpt-test',
    doGenerate: async () => step(generate),
    doStream: async () => ({ stream: streamOf(step(stream)), rawCall }),
  });
  return { model };
}

/** A module shaped like `ai` 4 (no `stepCountIs`), for the major check only. */
const aiV4Like: AiSdkModule = {
  generateText: () => Promise.resolve(undefined),
  streamText: () => undefined,
  jsonSchema: () => undefined,
};

const onV7 = (model: unknown, options = {}) => createFromAiSdk(model as LanguageModel, options, aiV7);

async function sendAndStream(makeProvider: () => LLMProvider) {
  const sent = addTool();
  const result = await createAgent({ provider: makeProvider(), tools: [sent.tool] }).send('What is 2 + 3?');
  expect(result.text).toBe('The sum is 5.');
  expect(sent.runs).toEqual([{ a: 2, b: 3 }]);

  const streamed = addTool();
  const run = createAgent({ provider: makeProvider(), tools: [streamed.tool] }).stream('What is 2 + 3?');
  const deltas: string[] = [];
  for await (const event of run) if (event.type === 'text.delta') deltas.push(event.text);
  expect(deltas.join('')).toBe('The sum is 5.');
  expect((await run.result).text).toBe('The sum is 5.');
  expect(streamed.runs).toEqual([{ a: 2, b: 3 }]);
}

describe('fromAiSdk() in createAgent (M2)', () => {
  itOnAiV4('ai 4: a MockLanguageModelV1 answers send() and stream(), with the tool loop', async () => {
    await sendAndStream(() => fromAiSdk(v4Model().model as LanguageModel));
  });

  it('ai 7: a MockLanguageModelV4 answers send() and stream(), with the tool loop', async () => {
    await sendAndStream(() => onV7(v7Model().model));
  });

  it('ai 7: the request carries the tool and no reasoning options; maxRetries defaults to 0', async () => {
    const { model, calls } = v7Model();
    await createAgent({ provider: onV7(model), tools: [addTool().tool], reasoning: 'high', retry: false }).send('2 + 3?');
    expect(calls[0]!.tools).toMatchObject([{ type: 'function', name: 'add' }]);
    expect(calls[0]!.providerOptions).toBeUndefined();
  });
});

describe('fromAiSdk() checks its model (M2)', () => {
  it('a model id string throws LOUSHO_CONFIG_INVALID, naming the provider function to import', () => {
    // A string is not a LanguageModel: the cast exercises the runtime guard.
    expect(() => fromAiSdk('openai/gpt-4o' as unknown as LanguageModel)).toThrow(expect.objectContaining({ code: 'LOUSHO_CONFIG_INVALID' }));
    expect(() => fromAiSdk('openai/gpt-4o' as unknown as LanguageModel)).toThrow(/gateway\('openai\/gpt-4o'\) from ai 7 or @ai-sdk\/gateway/);
  });

  it('a non-object throws LOUSHO_CONFIG_INVALID', () => {
    expect(() => fromAiSdk(null as unknown as LanguageModel)).toThrow(expect.objectContaining({ code: 'LOUSHO_CONFIG_INVALID' }));
  });

  it('a v1 model with ai 7 installed throws, naming both', () => {
    // A plain v1-shaped model: `ai/test` has no MockLanguageModelV1 when ai 7 is the installed `ai`.
    expect(() => onV7({ specificationVersion: 'v1', provider: 'mock', modelId: 'm' })).toThrow(
      expect.objectContaining({ code: 'LOUSHO_CONFIG_INVALID', message: expect.stringMatching(/specificationVersion v1\) but ai 7 is installed/) })
    );
  });

  it('a v4 model with ai 4 installed throws, naming both', () => {
    // A v4-shaped model where a v1 LanguageModel is declared: the cast exercises the runtime guard.
    expect(() => createFromAiSdk(v7Model().model as unknown as LanguageModel, {}, aiV4Like)).toThrow(
      expect.objectContaining({ code: 'LOUSHO_CONFIG_INVALID', message: expect.stringMatching(/specificationVersion v4\) but ai 4 is installed/) })
    );
  });

  it('another model id in the run throws; the wrapped id passes', async () => {
    const hint = "fromAiSdk() wraps one model (gemini-test); wrap another model with fromAiSdk() and use withFallback() instead of model: 'other-model'";
    const messages = [{ role: 'user' as const, content: 'hi' }];
    await expect(onV7(v7Model().model).generate({ messages, model: 'other-model' })).rejects.toMatchObject({
      code: 'LOUSHO_CONFIG_INVALID',
      message: expect.stringContaining(hint),
    });
    await expect(onV7(v7Model().model).stream({ messages, model: 'other-model' })).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID' });

    // A run reports provider failures as LOUSHO_PROVIDER_REQUEST_FAILED; the configuration error is its cause.
    const other = createAgent({ provider: onV7(v7Model().model), model: 'other-model', tools: [addTool().tool], retry: false });
    await expect(other.send('2 + 3?')).rejects.toMatchObject({
      message: expect.stringContaining(hint),
      cause: expect.objectContaining({ code: 'LOUSHO_CONFIG_INVALID' }),
    });

    const same = createAgent({ provider: onV7(v7Model().model), model: 'gemini-test', tools: [addTool().tool] });
    expect((await same.send('2 + 3?')).text).toBe('The sum is 5.');
  });
});

describe('fromAiSdk() options and metadata (M2)', () => {
  it("name defaults to the model's provider field, else 'ai-sdk'; the option wins", () => {
    expect(onV7(v7Model('google.generative-ai').model).name).toBe('google.generative-ai');
    expect(onV7({ specificationVersion: 'v4', modelId: 'm' }).name).toBe('ai-sdk');
    expect(onV7(v7Model('google.generative-ai').model, { name: 'gemini' }).name).toBe('gemini');
  });

  it('serves the wrapped model only, with tools and streaming on', async () => {
    const provider = onV7(v7Model().model);
    expect(provider.defaultModel).toBe('gemini-test');
    expect(await provider.getModels()).toEqual(['gemini-test']);
    expect(provider.supportsTools('gemini-test')).toBe(true);
    expect(provider.supportsStreaming('gemini-test')).toBe(true);
  });

  it('fileMediaTypes sends a PDF as a file part; without it the call is rejected, or the PDF becomes a text note on request', async () => {
    const input = [
      { type: 'text' as const, text: 'Summarize.' },
      { type: 'file' as const, data: PDF, mimeType: 'application/pdf', filename: 'a.pdf' },
    ];
    const withFiles = v7Model();
    await createAgent({ provider: onV7(withFiles.model, { fileMediaTypes: ['application/pdf'] }) }).send(input);
    const user = withFiles.calls[0]!.prompt.find((m) => m.role === 'user')!;
    expect(user.content).toEqual([
      { type: 'text', text: 'Summarize.' },
      expect.objectContaining({ type: 'file', mediaType: 'application/pdf', filename: 'a.pdf' }),
    ]);

    const strict = v7Model();
    await expect(onV7(strict.model).generate({ messages: [{ role: 'user', content: input }] })).rejects.toMatchObject({
      code: 'LOUSHO_UNSUPPORTED_CONTENT',
    });
    expect(strict.calls).toHaveLength(0);

    const without = v7Model();
    await createAgent({ provider: onV7(without.model, { unsupportedFiles: 'text-note' }) }).send(input);
    expect(JSON.stringify(without.calls[0]!.prompt)).toContain('[file a.pdf (application/pdf) not sent]');
  });

  it('under withFallback, a PDF the first model cannot take goes to the next model instead of being dropped (A9)', async () => {
    const input = [
      { type: 'text' as const, text: 'Extract the invoice.' },
      { type: 'file' as const, data: PDF, mimeType: 'application/pdf', filename: 'invoice.pdf' },
    ];
    const strict = v7Model();
    const pdf = v7Model();
    const provider = withFallback([
      onV7(strict.model, { name: 'text-only' }),
      onV7(pdf.model, { name: 'reads-pdf', fileMediaTypes: ['application/pdf'] }),
    ]);

    await createAgent({ provider, retry: false }).send(input);

    expect(strict.calls).toHaveLength(0);
    const user = pdf.calls[0]!.prompt.find((m) => m.role === 'user')!;
    expect(user.content).toEqual([
      { type: 'text', text: 'Extract the invoice.' },
      expect.objectContaining({ type: 'file', mediaType: 'application/pdf', filename: 'invoice.pdf' }),
    ]);
  });

  it('is exported from the package root', () => {
    expect(root.fromAiSdk).toBe(fromAiSdk);
    expect('createFromAiSdk' in root).toBe(false);
  });
});
