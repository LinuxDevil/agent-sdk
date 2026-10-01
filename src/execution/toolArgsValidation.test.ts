import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { AgentExecutor, ExecutionEvent } from './AgentExecutor';
import { ToolArgumentsValidationError } from './index';
import { ToolRegistry } from '../tools';
import { AgentBuilder } from '../core';
import { AgentType } from '../types';
import { HookRegistry } from './hooks';

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

/** Provider that emits one tool call per scripted entry, then a final answer. */
function scriptedProvider(calls: Array<{ name: string; args: unknown }>) {
  const seenMessages: any[][] = [];
  let step = 0;
  const provider = {
    name: 'mock',
    async generate(options: any) {
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
            function: { name: call.name, arguments: JSON.stringify(call.args) },
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
  return { provider: provider as any, seenMessages };
}

function setup(descriptor: Parameters<ToolRegistry['register']>[1]) {
  const toolRegistry = new ToolRegistry();
  toolRegistry.register('send', descriptor);
  const agent = AgentBuilder.create()
    .setType(AgentType.SmartAssistant)
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
      tool: { parameters: schema, execute } as any,
    });
    const { provider, seenMessages } = scriptedProvider([
      { name: 'send', args: { count: 'three' } },
      { name: 'send', args: { to: 'a@b.c', count: 3 } },
    ]);
    const events: ExecutionEvent[] = [];

    const result = await AgentExecutor.execute({
      agent,
      input: 'go',
      provider,
      toolRegistry,
      onEvent: e => events.push(e),
    });

    expect(result.text).toBe('done');
    expect(execute).toHaveBeenCalledTimes(1);

    const toolMessage = seenMessages[1].find(m => m.role === 'tool');
    const payload = JSON.parse(toolMessage.content);
    expect(payload.error).toBe('ToolArgumentsValidationError');
    expect(payload.toolName).toBe('send');
    expect(payload.message).toContain("Invalid arguments for tool 'send'");
    expect(payload.issues).toEqual(
      expect.arrayContaining([
        { path: 'to', message: 'Required' },
        { path: 'count', message: 'Expected number, received string' },
      ])
    );

    const toolResults = events.filter(e => e.type === 'tool-result') as any[];
    expect(toolResults[0].toolResult.error).toContain('Invalid arguments');
    expect(toolResults[1].toolResult.error).toBeUndefined();
  });

  it('passes the parsed value (defaults and transforms) to execute', async () => {
    const execute = vi.fn().mockResolvedValue('ok');
    const { toolRegistry, agent } = setup({
      displayName: 'Send',
      tool: { parameters: schema, execute } as any,
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
      tool: { parameters: schema, execute } as any,
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
    expect(needsApproval).toHaveBeenCalledWith({ to: 'a', count: 1, tag: 'general' });
    expect(pre).toHaveBeenCalledTimes(1);
    expect(pre.mock.calls[0][0].args).toEqual({ to: 'a', count: 1, tag: 'general' });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0][1].error).toContain('Invalid arguments');
    expect(post.mock.calls[1][1].error).toBeUndefined();
  });

  it('passes tools without a zod schema through unchanged', async () => {
    const execute = vi.fn().mockResolvedValue('ok');
    const noParams = setup({ displayName: 'Send', tool: { execute } as any });
    const plainObject = setup({
      displayName: 'Send',
      tool: { parameters: { type: 'object' }, execute } as any,
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
