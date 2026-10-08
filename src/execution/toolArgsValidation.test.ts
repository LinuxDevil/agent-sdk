import { describe, it, expect, vi } from 'vitest';
import type { Tool } from 'ai';
import type { LLMProvider, GenerateOptions } from '../providers';
import { z } from 'zod';
import { AgentExecutor } from './AgentExecutor';
import type { AgentEvent } from './agentEvents';
import { ToolArgumentsValidationError } from './index';
import { decodeToolArguments } from './toolArgsValidation';
import { resolveToolName, toolNotFoundMessage } from './toolNames';
import { ToolRegistry } from '../tools';
import { AgentBuilder } from '../core';
import { HookRegistry } from './hooks';

/** A message as the provider saw it (a JSON copy; tool results are text in these tests). */
type SeenMessage = { role: string; content: string; toolCallId?: string };

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

/** Provider that emits one tool call per scripted entry, then a final answer. */
function scriptedProvider(calls: Array<{ name: string; args?: unknown; raw?: string }>) {
  const seenMessages: SeenMessage[][] = [];
  let step = 0;
  const provider = {
    name: 'mock',
    async generate(options: GenerateOptions) {
      seenMessages.push(JSON.parse(JSON.stringify(options.messages)));
      const call = calls[step++];
      if (!call) {
        return { text: 'done', finishReason: 'stop' as const, usage };
      }
      return {
        text: '',
        finishReason: 'tool_calls' as const,
        usage,
        toolCalls: [
          {
            id: `call-${step}`,
            type: 'function' as const,
            function: { name: call.name, arguments: call.raw ?? JSON.stringify(call.args) },
          },
        ],
      };
    },
    async stream() {
      throw new Error('not implemented');
    },
    supportsTools: () => true,
    supportsStreaming: () => false,
    async getModels() {
      return [];
    },
  };
  return { provider: provider as LLMProvider, seenMessages };
}

function setup(descriptor: Parameters<ToolRegistry['register']>[1]) {
  const toolRegistry = new ToolRegistry();
  toolRegistry.register('send', descriptor);
  const agent = AgentBuilder.create()
    .setName('Test Agent')
    .addTool('send', { tool: 'send', options: {} })
    .build();
  return { toolRegistry, agent };
}

const schema = z.object({
  to: z.string(),
  count: z.number(),
  tag: z.string().default('general'),
  n: z.string().transform(Number).optional(),
});

describe('tool argument validation (LOU-U4)', () => {
  it('rejects invalid args, tells the model, and lets it correct itself', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const { toolRegistry, agent } = setup({
      displayName: 'Send',
      tool: { parameters: schema, execute } as Tool,
    });
    const { provider, seenMessages } = scriptedProvider([
      { name: 'send', args: { count: 'three' } },
      { name: 'send', args: { to: 'a@b.c', count: 3 } },
    ]);
    const events: AgentEvent[] = [];

    const result = await AgentExecutor.execute({
      agent,
      input: 'go',
      provider,
      toolRegistry,
      onAgentEvent: e => events.push(e),
    });

    expect(result.text).toBe('done');
    expect(execute).toHaveBeenCalledTimes(1);

    const toolMessage = seenMessages[1].find(m => m.role === 'tool');
    const payload = JSON.parse(toolMessage!.content);
    expect(payload.error).toBe('ToolArgumentsValidationError');
    expect(payload.toolName).toBe('send');
    expect(payload.message).toContain("Invalid arguments for tool 'send'");
    expect(payload.issues).toEqual(
      expect.arrayContaining([
        { path: 'to', message: 'Required' },
        { path: 'count', message: 'Expected number, received string' },
      ])
    );

    const toolErrors = events.filter(e => e.type === 'tool.error');
    const toolDones = events.filter(e => e.type === 'tool.done');
    expect(toolErrors[0].error.message).toContain('Invalid arguments');
    expect(toolDones).toHaveLength(1);
    expect(toolDones[0].toolName).toBe('send');
  });

  it('passes the parsed value (defaults and transforms) to execute', async () => {
    const execute = vi.fn().mockResolvedValue('ok');
    const { toolRegistry, agent } = setup({
      displayName: 'Send',
      tool: { parameters: schema, execute } as Tool,
    });
    const { provider } = scriptedProvider([
      { name: 'send', args: { to: 'a', count: 1, n: '42' } },
    ]);

    await AgentExecutor.execute({ agent, input: 'go', provider, toolRegistry });

    expect(execute.mock.calls[0][0]).toEqual({ to: 'a', count: 1, tag: 'general', n: 42 });
  });

  it('gives the approval predicate and hooks parsed args, and skips them on invalid args', async () => {
    const execute = vi.fn().mockResolvedValue('ok');
    const needsApproval = vi.fn().mockReturnValue(false);
    const { toolRegistry, agent } = setup({
      displayName: 'Send',
      tool: { parameters: schema, execute } as Tool,
      needsApproval,
    });
    const pre = vi.fn();
    const post = vi.fn();
    const hooks = new HookRegistry();
    hooks.register({ name: 'spy', preToolCall: pre, postToolCall: post });
    const { provider } = scriptedProvider([
      { name: 'send', args: { to: 1 } },
      { name: 'send', args: { to: 'a', count: 1 } },
    ]);

    await AgentExecutor.execute({ agent, input: 'go', provider, toolRegistry, hooks });

    expect(needsApproval).toHaveBeenCalledTimes(1);
    expect(needsApproval).toHaveBeenCalledWith({ to: 'a', count: 1, tag: 'general' }, expect.objectContaining({ toolName: 'send' }));
    expect(pre).toHaveBeenCalledTimes(1);
    expect(pre.mock.calls[0][0].args).toEqual({ to: 'a', count: 1, tag: 'general' });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0][1].error).toContain('Invalid arguments');
    expect(post.mock.calls[1][1].error).toBeUndefined();
  });

  it('passes tools without a zod schema through unchanged', async () => {
    const execute = vi.fn().mockResolvedValue('ok');
    const noParams = setup({ displayName: 'Send', tool: { execute } as Partial<Tool> as Tool });
    const plainObject = setup({
      displayName: 'Send',
      tool: { parameters: { type: 'object' }, execute } as Tool,
    });

    for (const { toolRegistry, agent } of [noParams, plainObject]) {
      const { provider } = scriptedProvider([{ name: 'send', args: { anything: [1] } }]);
      await AgentExecutor.execute({ agent, input: 'go', provider, toolRegistry });
    }

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledWith({ anything: [1] }, expect.anything());
  });

  it('exposes a typed error with issues', () => {
    const error = new ToolArgumentsValidationError('t', [{ path: '(root)', message: 'bad' }]);
    expect(error).toBeInstanceOf(Error);
    expect(error.issues).toEqual([{ path: '(root)', message: 'bad' }]);
    expect(error.message).toBe("Invalid arguments for tool 't': 1 issue ((root): bad)");
  });
});

describe('malformed tool-call arguments (audit F7)', () => {
  const pathSchema = z.object({ path: z.string().optional() });

  async function runRaw(raw: string, name = 'send') {
    const execute = vi.fn().mockResolvedValue('ok');
    const { toolRegistry, agent } = setup({ displayName: 'Send', tool: { parameters: pathSchema, execute } as Tool });
    const { provider, seenMessages } = scriptedProvider([{ name, raw }]);
    const events: AgentEvent[] = [];
    await AgentExecutor.execute({ agent, input: 'go', provider, toolRegistry, onAgentEvent: e => events.push(e) });
    const toolMessage = seenMessages[1].find(m => m.role === 'tool');
    return { execute, events, content: toolMessage!.content };
  }

  it('rejects truncated JSON instead of running the tool with {}', async () => {
    const { execute, events, content } = await runRaw('{"path":"src"');

    expect(execute).not.toHaveBeenCalled();
    const payload = JSON.parse(content);
    expect(payload.error).toBe('ToolArgumentsValidationError');
    expect(payload.kind).toBe('validation');
    expect(payload.issues[0].path).toBe('(root)');
    expect(payload.issues[0].message).toMatch(/^arguments are not valid JSON: .+; received: \{"path":"src"$/);
    const start = events.find(e => e.type === 'tool.start');
    expect(start).toMatchObject({ args: {}, rawArgs: '{"path":"src"' });
    expect(events.some(e => e.type === 'tool.error')).toBe(true);
  });

  it.each([
    ['a markdown code fence', '```json\n{"path":"src"}\n```'],
    ['a trailing comma', '{"path":"src",}'],
    ['double-encoded JSON', JSON.stringify(JSON.stringify({ path: 'src' }))],
  ])('repairs %s and runs the tool', async (_label, raw) => {
    const { execute, events } = await runRaw(raw);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toEqual({ path: 'src' });
    expect(events.find(e => e.type === 'tool.start')).toMatchObject({ args: { path: 'src' }, rawArgs: raw });
  });

  it('treats empty arguments as {} and leaves valid JSON without rawArgs', async () => {
    const empty = await runRaw('');
    expect(empty.execute.mock.calls[0][0]).toEqual({});
    const valid = await runRaw('{"path":"a"}');
    const start = valid.events.find(e => e.type === 'tool.start');
    expect(start).toMatchObject({ args: { path: 'a' } });
    expect(start).not.toHaveProperty('rawArgs');
  });

  it('decodes only repairs that yield an object', () => {
    expect(decodeToolArguments('   ')).toEqual({ ok: true, value: {} });
    expect(decodeToolArguments('{"a":"x,}"}')).toEqual({ ok: true, value: { a: 'x,}' } });
    expect(decodeToolArguments('{"a":"x,}",}')).toEqual({ ok: true, value: { a: 'x,}' }, repaired: true });
    expect(decodeToolArguments('[1,2,]')).toMatchObject({ ok: false });
    expect(decodeToolArguments('"just text"')).toEqual({ ok: true, value: 'just text' });
  });

  it('truncates long raw text in the message', async () => {
    const { content } = await runRaw(`{"path":"${'x'.repeat(500)}`);
    expect(JSON.parse(content).issues[0].message).toMatch(/\.\.\. \(509 chars\)$/);
  });
});

describe('tool-not-found suggestions (audit F13)', () => {
  it('resolves a model-added prefix to the real tool and runs it', async () => {
    const execute = vi.fn().mockResolvedValue('ok');
    const { toolRegistry, agent } = setup({ displayName: 'Send', tool: { parameters: z.object({}), execute } as Tool });
    const { provider } = scriptedProvider([{ name: 'functions.send', args: {} }]);
    const events: AgentEvent[] = [];

    await AgentExecutor.execute({ agent, input: 'go', provider, toolRegistry, onAgentEvent: e => events.push(e) });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(events.find(e => e.type === 'tool.start')).toMatchObject({ toolName: 'send' });
  });

  it('suggests the closest tool name and lists the available tools', async () => {
    const { toolRegistry, agent } = setup({ displayName: 'Send', tool: { parameters: z.object({}), execute: vi.fn() } as Tool });
    const { provider, seenMessages } = scriptedProvider([{ name: 'sned', args: {} }]);

    await AgentExecutor.execute({ agent, input: 'go', provider, toolRegistry });

    const payload = JSON.parse(seenMessages[1].find(m => m.role === 'tool')!.content);
    expect(payload.kind).toBe('not-found');
    expect(payload.message).toBe("Tool 'sned' not found. Did you mean 'send'? Available tools: send");
  });

  it('only strips a prefix when the rest is a known tool', () => {
    const known = new Set(['read_file', 'functions.custom']);
    expect(resolveToolName('functions.read_file', known)).toBe('read_file');
    expect(resolveToolName('tools.read_file', known)).toBe('read_file');
    expect(resolveToolName('functions.custom', known)).toBe('functions.custom');
    expect(resolveToolName('functions.nope', known)).toBe('functions.nope');
    expect(toolNotFoundMessage('ghost', [])).toBe("Tool 'ghost' not found");
    expect(toolNotFoundMessage('zzzzzz', ['read_file'])).toBe("Tool 'zzzzzz' not found. Available tools: read_file");
  });
});
