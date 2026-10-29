import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentExecutor } from './AgentExecutor';
import { Span, TraceExporter } from './tracing';
import { CAPTURE_CONTENT_ENV } from './semconv';
import { FlowExecutor } from '../flows/FlowExecutor';
import { ToolRegistry, defineTool } from '../tools';
import { AgentBuilder } from '../core';
import { AgentFlow } from '../types/flow';
import { mockModel } from '../testing';

/** In-memory exporter: remembers every span, in start order, in its final state. */
function memoryExporter() {
  const spans: Span[] = [];
  const exporter: TraceExporter = {
    onSpanStart: (span) => spans.push(span),
    onSpanEnd: () => undefined,
  };
  return { exporter, spans };
}

const weather = defineTool({
  name: 'get_weather',
  description: 'Get the weather for a city',
  input: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, tempC: 21 }),
});

function setup(tools: ToolRegistry = new ToolRegistry()) {
  tools.register(weather);
  const agent = {
    ...AgentBuilder.create()
      .setName('Weather Bot')
      .addTool('get_weather', { tool: 'get_weather', options: {} })
      .build(),
    id: 'agent-1',
    prompt: 'You are terse.',
    settings: { model: 'test-model' },
  };
  return { agent, toolRegistry: tools };
}

function modelWithOneToolCall() {
  return mockModel([
    {
      toolCalls: [{ id: 'call_abc', name: 'get_weather', args: { city: 'Paris' } }],
      usage: { inputTokens: 10, outputTokens: 5 },
    },
    { text: 'It is 21C in Paris.', usage: { inputTokens: 20, outputTokens: 7 } },
  ]);
}

async function runAgent(extra: { captureContent?: boolean; redactContent?: boolean | ((text: string) => string) } = {}) {
  const { agent, toolRegistry } = setup();
  const { exporter, spans } = memoryExporter();
  const provider = modelWithOneToolCall();
  await AgentExecutor.execute({
    agent,
    input: 'Weather in Paris?',
    provider,
    toolRegistry,
    exporter,
    sessionId: 'session-9',
    temperature: 0.2,
    maxTokens: 256,
    // The deprecated content attributes are dual-emitted only on an explicit opt-out of redaction.
    redactContent: false,
    ...extra,
  });
  return { spans, provider };
}

describe('OpenTelemetry GenAI semantic conventions', () => {
  afterEach(() => {
    delete process.env[CAPTURE_CONTENT_ENV];
  });

  it('names spans and sets kinds per the invoke_agent / chat / execute_tool conventions', async () => {
    const { spans } = await runAgent();

    expect(spans.map((s) => [s.name, s.kind])).toEqual([
      ['invoke_agent Weather Bot', 'internal'],
      ['chat test-model', 'client'],
      ['execute_tool get_weather', 'internal'],
      ['chat test-model', 'client'],
    ]);
    const [agentSpan, ...children] = spans;
    expect(children.every((s) => s.parentId === agentSpan.id)).toBe(true);
  });

  it('records the exact agent-run attribute keys and values', async () => {
    const { spans, provider } = await runAgent();

    expect(spans[0].attributes).toEqual({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'Weather Bot',
      'gen_ai.agent.id': 'agent-1',
      'gen_ai.provider.name': provider.name,
      'gen_ai.request.model': 'test-model',
      'gen_ai.conversation.id': 'session-9',
      // The run's total over its model calls.
      'gen_ai.usage.input_tokens': 30,
      'gen_ai.usage.output_tokens': 12,
      input: 'Weather in Paris?', // deprecated
    });
  });

  it('records the exact model-call attribute keys and values (dual-emitting the deprecated names)', async () => {
    const { spans, provider } = await runAgent();

    expect(spans[1].attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': provider.name,
      'gen_ai.request.model': 'test-model',
      'gen_ai.request.temperature': 0.2,
      'gen_ai.request.max_tokens': 256,
      'gen_ai.response.finish_reasons': ['tool_call'],
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 5,
    });
    expect(Object.keys(spans[1].attributes).sort()).toEqual(
      [
        'gen_ai.operation.name',
        'gen_ai.provider.name',
        'gen_ai.request.model',
        'gen_ai.request.temperature',
        'gen_ai.request.max_tokens',
        'gen_ai.response.finish_reasons',
        'gen_ai.usage.input_tokens',
        'gen_ai.usage.output_tokens',
        // deprecated, still emitted
        'model',
        'prompt',
        'promptTokens',
        'completionTokens',
        'totalTokens',
        'finishReason',
      ].sort()
    );
    expect(spans[1].attributes).toMatchObject({
      model: 'test-model',
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      finishReason: 'tool_calls',
    });
    expect(spans[3].attributes['gen_ai.response.finish_reasons']).toEqual(['stop']);
  });

  it('records the exact tool-execution attribute keys and values', async () => {
    const { spans } = await runAgent();

    expect(spans[2].attributes).toEqual({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'get_weather',
      'gen_ai.tool.call.id': 'call_abc',
      'gen_ai.tool.description': 'Get the weather for a city',
      'gen_ai.tool.type': 'function',
      'gen_ai.agent.name': 'Weather Bot',
      'gen_ai.conversation.id': 'session-9',
      // deprecated
      toolName: 'get_weather',
      args: { city: 'Paris' },
      result: { city: 'Paris', tempC: 21 },
      latencyMs: expect.any(Number),
    });
    expect(spans[2].status).toBeUndefined();
  });

  it('never records gen_ai content attributes by default', async () => {
    const { spans } = await runAgent();

    const contentKeys = [
      'gen_ai.input.messages',
      'gen_ai.output.messages',
      'gen_ai.system_instructions',
      'gen_ai.tool.call.arguments',
      'gen_ai.tool.call.result',
    ];
    for (const span of spans) {
      for (const key of contentKeys) {
        expect(span.attributes).not.toHaveProperty(key);
      }
    }
  });

  it('records content on the spec attributes when captureContent is true', async () => {
    const { spans } = await runAgent({ captureContent: true });

    expect(JSON.parse(spans[0].attributes['gen_ai.input.messages'] as string)).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'Weather in Paris?' }] },
    ]);
    expect(JSON.parse(spans[1].attributes['gen_ai.system_instructions'] as string)).toEqual([
      { type: 'text', content: 'You are terse.' },
    ]);
    expect(JSON.parse(spans[1].attributes['gen_ai.input.messages'] as string)).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'Weather in Paris?' }] },
    ]);
    expect(JSON.parse(spans[1].attributes['gen_ai.output.messages'] as string)).toEqual([
      {
        role: 'assistant',
        parts: [{ type: 'tool_call', id: 'call_abc', name: 'get_weather', arguments: { city: 'Paris' } }],
      },
    ]);
    expect(JSON.parse(spans[2].attributes['gen_ai.tool.call.arguments'] as string)).toEqual({ city: 'Paris' });
    expect(JSON.parse(spans[2].attributes['gen_ai.tool.call.result'] as string)).toEqual({
      city: 'Paris',
      tempC: 21,
    });
    // The follow-up model call sees the tool result as a tool_call_response part.
    const followUp = JSON.parse(spans[3].attributes['gen_ai.input.messages'] as string);
    expect(followUp.at(-1)).toEqual({
      role: 'tool',
      parts: [{ type: 'tool_call_response', id: 'call_abc', response: { city: 'Paris', tempC: 21 } }],
    });
  });

  it('honors the OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT env var, which captureContent overrides', async () => {
    process.env[CAPTURE_CONTENT_ENV] = 'true';
    const viaEnv = await runAgent();
    expect(viaEnv.spans[1].attributes).toHaveProperty('gen_ai.input.messages');

    const overridden = await runAgent({ captureContent: false });
    expect(overridden.spans[1].attributes).not.toHaveProperty('gen_ai.input.messages');
  });

  it('records error.type and an error status when the model call throws', async () => {
    const { agent, toolRegistry } = setup();
    const { exporter, spans } = memoryExporter();
    const provider = mockModel([]);

    await expect(
      AgentExecutor.execute({ agent, input: 'hi', provider, toolRegistry, exporter })
    ).rejects.toThrow();

    const chat = spans.find((s) => s.name.startsWith('chat'))!;
    expect(chat.attributes['error.type']).toEqual(expect.any(String));
    expect(chat.attributes['error.type']).not.toBe('');
    expect(chat.status).toMatchObject({ code: 'error' });
    expect(spans[0].status).toMatchObject({ code: 'error' });
    expect(spans[0].attributes['error.type']).toEqual(expect.any(String));
  });

  it('records error.type and an error status when a tool fails', async () => {
    const failing = defineTool({
      name: 'get_weather',
      description: 'Always fails',
      input: z.object({ city: z.string() }),
      execute: async () => {
        throw new TypeError('upstream down');
      },
    });
    const registry = new ToolRegistry();
    registry.register(failing);
    const { agent } = setup(new ToolRegistry());
    const { exporter, spans } = memoryExporter();

    await AgentExecutor.execute({
      agent,
      input: 'Weather in Paris?',
      provider: modelWithOneToolCall(),
      toolRegistry: registry,
      exporter,
    });

    const tool = spans.find((s) => s.name === 'execute_tool get_weather')!;
    expect(tool.attributes['error.type']).toBe('tool_error');
    expect(tool.attributes.error).toContain('upstream down');
    expect(tool.status?.code).toBe('error');
    expect(tool.status?.message).toBe(tool.attributes.error);
    expect(tool.attributes).not.toHaveProperty('gen_ai.tool.call.result');
  });

  it('still honors redactContent for the deprecated content attributes', async () => {
    const { spans } = await runAgent({ redactContent: true });

    expect(spans[0].attributes).not.toHaveProperty('input');
    expect(spans[1].attributes).not.toHaveProperty('prompt');
    expect(spans[2].attributes).not.toHaveProperty('args');
    expect(spans[2].attributes).not.toHaveProperty('result');
    expect(spans[1].attributes['gen_ai.usage.input_tokens']).toBe(10);
  });

  it('scrubs API-key shapes from captured content when redactContent is true', async () => {
    const key = 'sk-or-v1-0123456789abcdef0123456789abcdef';
    const { agent, toolRegistry } = setup();
    const { exporter, spans } = memoryExporter();
    await AgentExecutor.execute({
      agent: { ...agent, prompt: `Use ${key} when asked.` },
      input: `My key is ${key}`,
      provider: mockModel([
        { toolCalls: [{ id: 'call_k', name: 'get_weather', args: { city: key } }] },
        { text: `Done with ${key}` },
      ]),
      toolRegistry,
      exporter,
      captureContent: true,
      redactContent: true,
    });

    const content = spans.flatMap((s) => Object.entries(s.attributes).filter(([k]) => k.startsWith('gen_ai.')));
    expect(JSON.stringify(content)).not.toContain(key);
    const chat = spans.find((s) => s.name.startsWith('chat'))!;
    expect(JSON.parse(chat.attributes['gen_ai.input.messages'] as string)).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'My key is [redacted]' }] },
    ]);
    expect(JSON.parse(chat.attributes['gen_ai.system_instructions'] as string)[0].content).toBe('Use [redacted] when asked.');
    const tool = spans.find((s) => s.name.startsWith('execute_tool'))!;
    expect(JSON.parse(tool.attributes['gen_ai.tool.call.arguments'] as string)).toEqual({ city: '[redacted]' });
  });

  it('scrubs captured content when redactContent is not set', async () => {
    const key = 'ghp_0123456789abcdefABCDEF0123456789';
    const { agent, toolRegistry } = setup();
    const { exporter, spans } = memoryExporter();
    await AgentExecutor.execute({ agent, input: `token ${key}`, provider: mockModel(['ok']), toolRegistry, exporter, captureContent: true });
    expect(JSON.parse(spans[0].attributes['gen_ai.input.messages'] as string)[0].parts[0].content).toBe('token [redacted]');
  });

  it('applies a custom redactor function', async () => {
    const seen: string[] = [];
    const { spans } = await runAgent({
      captureContent: true,
      redactContent: (text) => {
        seen.push(text);
        return text.replace(/Paris/g, '<city>');
      },
    });

    expect(seen).toContain('Weather in Paris?');
    expect(JSON.parse(spans[0].attributes['gen_ai.input.messages'] as string)[0].parts[0].content).toBe('Weather in <city>?');
    expect(JSON.parse(spans[2].attributes['gen_ai.tool.call.arguments'] as string)).toEqual({ city: '<city>' });
    expect(JSON.parse(spans[2].attributes['gen_ai.tool.call.result'] as string)).toEqual({ city: '<city>', tempC: 21 });
    // A function counts as redaction on: the deprecated attributes stay off.
    expect(spans[1].attributes).not.toHaveProperty('prompt');
  });

  it('falls back to [redacted] when a custom redactor throws, without failing the run', async () => {
    const { spans } = await runAgent({
      captureContent: true,
      redactContent: () => {
        throw new Error('boom');
      },
    });
    expect(JSON.parse(spans[0].attributes['gen_ai.input.messages'] as string)[0].parts[0].content).toBe('[redacted]');
  });

  describe('tool error text', () => {
    const secret = 'abcdefghij0123456789ABCD';
    const token = 'Bearer ' + secret;
    const failing = defineTool({
      name: 'get_weather',
      description: 'Get the weather for a city',
      input: z.object({ city: z.string() }),
      execute: async () => {
        throw new Error(`upstream rejected ${token}`);
      },
    });

    async function failedToolSpan(redactContent?: boolean | ((text: string) => string)) {
      const { agent } = setup();
      const toolRegistry = new ToolRegistry();
      toolRegistry.register(failing);
      const { exporter, spans } = memoryExporter();
      await AgentExecutor.execute({
        agent,
        input: 'Weather?',
        provider: modelWithOneToolCall(),
        toolRegistry,
        exporter,
        ...(redactContent === undefined ? {} : { redactContent }),
      });
      return spans.find((s) => s.name.startsWith('execute_tool'))!;
    }

    it('scrubs the error message on a failed tool span by default', async () => {
      const tool = await failedToolSpan();
      expect(tool.attributes.error).toContain('Bearer [redacted]');
      expect(JSON.stringify([tool.attributes, tool.status])).not.toContain(secret);
      expect(tool.status?.message).toContain('Bearer [redacted]');
    });

    it('keeps the error message under redactContent: false', async () => {
      const tool = await failedToolSpan(false);
      expect(tool.attributes.error).toContain(token);
      expect(tool.status?.message).toContain(token);
    });

    it('applies a custom redactor to the error message', async () => {
      const tool = await failedToolSpan((text) => text.replace('upstream', 'remote'));
      expect(tool.status?.message).toContain('remote rejected');
    });

    it.each([
      [false, true],
      [undefined, false],
    ])('redactContent %s keeps (%s) the provider error text on the run span', async (redactContent, keeps) => {
      const { agent, toolRegistry } = setup();
      const { exporter, spans } = memoryExporter();
      const provider = mockModel([]);
      provider.generate = async () => {
        throw new Error(`provider said ${token}`);
      };
      await AgentExecutor.execute({ agent, input: 'hi', provider, toolRegistry, exporter, ...(redactContent === undefined ? {} : { redactContent }) }).catch(() => undefined);
      const run = spans.find((s) => s.name.startsWith('invoke_agent'))!;
      const chat = spans.find((s) => s.name.startsWith('chat'))!;
      for (const span of [run, chat]) {
        expect(JSON.stringify([span.attributes.error, span.status]).includes(secret)).toBe(keeps);
      }
    });

    it('scrubs the error recorded on the run span when the run itself fails', async () => {
      const { agent, toolRegistry } = setup();
      const { exporter, spans } = memoryExporter();
      const provider = mockModel([]);
      provider.generate = async () => {
        throw new Error(`provider said ${token}`);
      };
      await AgentExecutor.execute({ agent, input: 'hi', provider, toolRegistry, exporter }).catch(() => undefined);
      const text = JSON.stringify(spans.map((s) => [s.attributes.error, s.status]));
      expect(text).toContain('provider said');
      expect(text).not.toContain(secret);
    });
  });

  it('does not scrub captured content when redactContent is false', async () => {
    const key = 'sk-or-v1-0123456789abcdef0123456789abcdef';
    const { agent, toolRegistry } = setup();
    const { exporter, spans } = memoryExporter();
    await AgentExecutor.execute({ agent, input: key, provider: mockModel(['ok']), toolRegistry, exporter, captureContent: true, redactContent: false });
    expect(spans[0].attributes['gen_ai.input.messages']).toContain(key);
  });

  it.each([false, true, (text: string) => text] as const)(
    'encodes tool args and results as JSON.stringify does (Date as ISO, toJSON honored) with redactContent %s',
    async (redactContent) => {
      const { recordToolOutcome } = await import('./genAiSpans');
      const at = new Date('2026-10-24T12:00:00.000Z');
      const span: Span = { id: 's', name: 'execute_tool t', attributes: {}, startTime: 0 };
      const money = { toJSON: () => '12.50' };
      recordToolOutcome(span, { args: { at }, result: { at, money }, latencyMs: 1 }, { captureContent: true, redactContent });
      expect(span.attributes['gen_ai.tool.call.arguments']).toBe('{"at":"2026-10-24T12:00:00.000Z"}');
      expect(span.attributes['gen_ai.tool.call.result']).toBe('{"at":"2026-10-24T12:00:00.000Z","money":"12.50"}');
    }
  );

  it('fails on a cyclic tool result the way JSON.stringify does, whatever redactContent is', async () => {
    const { recordToolOutcome } = await import('./genAiSpans');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const redactContent of [false, true]) {
      const span: Span = { id: 's', name: 'execute_tool t', attributes: {}, startTime: 0 };
      expect(() =>
        recordToolOutcome(span, { args: {}, result: cyclic, latencyMs: 1 }, { captureContent: true, redactContent })
      ).toThrow(TypeError);
    }
  });

  it('emits a Message[] input on invoke_agent as message parts, not a double-encoded string', async () => {
    const { agent, toolRegistry } = setup();
    const { exporter, spans } = memoryExporter();
    await AgentExecutor.execute({
      agent,
      input: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'Weather in Paris?' },
      ],
      provider: mockModel(['Sunny.']),
      toolRegistry,
      exporter,
      captureContent: true,
    });

    // One JSON.parse yields the spec's message schema; `content` is the
    // literal text, not a second JSON document.
    expect(JSON.parse(spans[0].attributes['gen_ai.input.messages'] as string)).toEqual([
      { role: 'system', parts: [{ type: 'text', content: 'Be terse.' }] },
      { role: 'user', parts: [{ type: 'text', content: 'Weather in Paris?' }] },
    ]);
  });
});

describe('traced flows', () => {
  const flow: AgentFlow = {
    code: 'weather-flow',
    name: 'Weather Flow',
    flow: {
      type: 'sequence',
      id: 'root',
      steps: [
        { type: 'toolCall', id: 'lookup', tool: 'get_weather', arguments: { city: 'Paris' }, outputVariable: 'w' },
        { type: 'llmCall', id: 'summarize', prompt: 'Summarize {{w}}', outputVariable: 'summary' },
        { type: 'return', id: 'done', value: '$summary' },
      ],
    },
  } as AgentFlow;

  function flowContext(extra: object = {}) {
    const { agent, toolRegistry } = setup();
    const { exporter, spans } = memoryExporter();
    const provider = mockModel([{ text: 'Sunny.', usage: { inputTokens: 3, outputTokens: 1 } }]);
    return {
      spans,
      context: { agent, provider, toolRegistry, variables: {}, exporter, ...extra },
    };
  }

  it('wraps the run and each node in spans, parenting model and tool spans under their node', async () => {
    const { spans, context } = flowContext();

    const result = await FlowExecutor.execute(flow, context);

    expect(result.success).toBe(true);
    expect(spans.map((s) => s.name)).toEqual([
      'invoke_workflow Weather Flow',
      'flow.node sequence',
      'flow.node toolCall',
      'execute_tool get_weather',
      'flow.node llmCall',
      'chat test-model',
      'flow.node return',
    ]);
    const byName = (name: string) => spans.find((s) => s.name === name)!;
    const run = byName('invoke_workflow Weather Flow');
    const sequence = byName('flow.node sequence');
    expect(run.parentId).toBeUndefined();
    expect(sequence.parentId).toBe(run.id);
    expect(byName('flow.node toolCall').parentId).toBe(sequence.id);
    expect(byName('flow.node llmCall').parentId).toBe(sequence.id);
    expect(byName('flow.node return').parentId).toBe(sequence.id);
    expect(byName('execute_tool get_weather').parentId).toBe(byName('flow.node toolCall').id);
    expect(byName('chat test-model').parentId).toBe(byName('flow.node llmCall').id);
    expect(byName('chat test-model').kind).toBe('client');
  });

  it('records flow and node attributes and outcomes', async () => {
    const { spans, context } = flowContext();

    await FlowExecutor.execute(flow, context);

    expect(spans[0].attributes).toEqual({
      'gen_ai.operation.name': 'invoke_workflow',
      'gen_ai.workflow.name': 'Weather Flow',
      'lousho.flow.code': 'weather-flow',
      'lousho.flow.outcome': 'success',
    });
    expect(spans[2].attributes).toEqual({
      'lousho.flow.node.id': 'lookup',
      'lousho.flow.node.type': 'toolCall',
      'lousho.flow.outcome': 'success',
    });
    expect(spans[5].attributes['gen_ai.usage.input_tokens']).toBe(3);
  });

  it('nests the run under a parent span when parentSpanId is given', async () => {
    const { spans, context } = flowContext({ parentSpanId: 'agent-span-1' });

    await FlowExecutor.execute(flow, context);

    expect(spans[0].parentId).toBe('agent-span-1');
  });

  it('marks failed nodes and the run with error outcome, error.type and error status', async () => {
    const failing = {
      code: 'bad',
      name: 'Bad Flow',
      flow: { type: 'sequence', id: 'root', steps: [{ type: 'throw', id: 'boom', message: 'nope' }] },
    } as AgentFlow;
    const { spans, context } = flowContext();

    const result = await FlowExecutor.execute(failing, context);

    expect(result.success).toBe(false);
    const run = spans[0];
    const boom = spans.find((s) => s.name === 'flow.node throw')!;
    for (const span of [run, boom]) {
      expect(span.attributes['lousho.flow.outcome']).toBe('error');
      expect(span.attributes['error.type']).toBe('Error');
      expect(span.status).toEqual({ code: 'error', message: 'nope' });
    }
  });

  it('records no content attributes unless captureContent is set', async () => {
    const off = flowContext();
    await FlowExecutor.execute(flow, off.context);
    expect(off.spans[5].attributes).not.toHaveProperty('gen_ai.input.messages');
    expect(off.spans[3].attributes).not.toHaveProperty('gen_ai.tool.call.arguments');

    const on = flowContext({ captureContent: true });
    await FlowExecutor.execute(flow, on.context);
    expect(on.spans[5].attributes).toHaveProperty('gen_ai.input.messages');
    expect(on.spans[3].attributes['gen_ai.tool.call.arguments']).toBe(JSON.stringify({ city: 'Paris' }));
  });
});

describe('lousho.cost_usd and lousho.usage.estimated spans', () => {
  async function runPriced(model: string, scripted: boolean) {
    const { agent, toolRegistry } = setup();
    const { exporter, spans } = memoryExporter();
    const provider = scripted
      ? modelWithOneToolCall()
      : mockModel([{ toolCalls: [{ id: 'c1', name: 'get_weather', args: { city: 'Paris' } }] }, 'It is 21C.']);
    const result = await AgentExecutor.execute({
      agent: { ...agent, settings: { model } },
      input: 'Weather in Paris?',
      provider,
      toolRegistry,
      exporter,
    });
    return { spans, result };
  }

  const gpt4oMini = (input: number, output: number) => (input * 0.15 + output * 0.6) / 1e6;

  it('records the step cost on each chat span and the cumulative cost on the invoke_agent span', async () => {
    const { spans, result } = await runPriced('gpt-4o-mini', true);
    const [run, chat1, tool, chat2] = spans;

    expect(chat1.attributes['lousho.cost_usd']).toBeCloseTo(gpt4oMini(10, 5), 12);
    expect(chat2.attributes['lousho.cost_usd']).toBeCloseTo(gpt4oMini(20, 7), 12);
    expect(run.attributes['lousho.cost_usd']).toBeCloseTo(gpt4oMini(30, 12), 12);
    expect(run.attributes['lousho.cost_usd']).toBeCloseTo(result.usage.costUsd as number, 12);
    expect(tool.attributes).not.toHaveProperty('lousho.cost_usd');
    for (const span of [run, chat1, chat2]) expect(span.attributes).not.toHaveProperty('lousho.usage.estimated');
  });

  it('omits lousho.cost_usd when the model has no known price', async () => {
    const { spans } = await runPriced('test-model', true);
    expect(spans.some((s) => 'lousho.cost_usd' in s.attributes)).toBe(false);
  });

  it('flags lousho.usage.estimated on the chat spans and the run span when tokens were estimated', async () => {
    const { spans, result } = await runPriced('gpt-4o-mini', false);
    const [run, chat1, , chat2] = spans;

    expect(result.usage.estimated).toBe(true);
    expect(run.attributes['lousho.usage.estimated']).toBe(true);
    expect(chat1.attributes['lousho.usage.estimated']).toBe(true);
    expect(chat2.attributes['lousho.usage.estimated']).toBe(true);
    expect(run.attributes['lousho.cost_usd']).toBeCloseTo(result.usage.costUsd as number, 12);
  });
});

describe('gen_ai.response.id on chat spans', () => {
  it("records the provider's response id (AI SDK response.id, else an OpenAI-style id)", async () => {
    const { recordLlmResult } = await import('./genAiSpans');
    const span = (): Span => ({ id: 's', name: 'chat m', attributes: { 'gen_ai.request.model': 'm' }, startTime: 0 });
    const aiSdk = span();
    recordLlmResult(aiSdk, { text: 'hi', finishReason: 'stop', rawResponse: { response: { id: 'resp_1', modelId: 'm-1' } } }, { captureContent: false });
    expect(aiSdk.attributes).toMatchObject({ 'gen_ai.response.id': 'resp_1', 'gen_ai.response.model': 'm-1' });
    const openAi = span();
    recordLlmResult(openAi, { text: 'hi', finishReason: 'stop', rawResponse: { id: 'chatcmpl-2' } }, { captureContent: false });
    expect(openAi.attributes['gen_ai.response.id']).toBe('chatcmpl-2');
    const none = span();
    recordLlmResult(none, { text: 'hi', finishReason: 'stop' }, { captureContent: false });
    expect(none.attributes).not.toHaveProperty('gen_ai.response.id');
  });
});
