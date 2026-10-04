import { describe, it, expect, vi } from 'vitest';
import type { Tool } from 'ai';
import type { LLMProvider, GenerateOptions } from '../providers';
import { z } from 'zod';
import { AgentExecutor } from './AgentExecutor';
import type { AgentEvent } from './agentEvents';
import { PropagatingToolError } from './propagatingToolError';
import { HookRegistry } from './hooks';
import { ToolRegistry } from '../tools';
import { AgentBuilder } from '../core';

/** A message as the provider saw it (a JSON copy; tool results are text in these tests). */
type SeenMessage = { role: string; content: string; toolCallId?: string };

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

/** Provider that calls `boom` for `steps` turns, then answers. */
function scriptedProvider(steps: number) {
  const seenMessages: SeenMessage[][] = [];
  let step = 0;
  const provider = {
    name: 'mock',
    async generate(options: GenerateOptions) {
      seenMessages.push(JSON.parse(JSON.stringify(options.messages)));
      if (step++ >= steps) {
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
            function: { name: 'boom', arguments: '{}' },
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

function setup(execute: () => Promise<unknown>) {
  const toolRegistry = new ToolRegistry();
  toolRegistry.register('boom', {
    displayName: 'Boom',
    tool: { parameters: z.object({}), execute } as Tool,
  });
  const agent = AgentBuilder.create()
    .setName('Test Agent')
    .addTool('boom', { tool: 'boom', options: {} })
    .build();
  return { toolRegistry, agent };
}

describe('thrown tool errors reach the model (LOU-U12)', () => {
  it('sends a structured error, then the model recovers', async () => {
    let calls = 0;
    const { toolRegistry, agent } = setup(async () => {
      if (calls++ === 0) {
        throw new TypeError('query must not be empty');
      }
      return { ok: true };
    });
    const { provider, seenMessages } = scriptedProvider(2);
    const events: AgentEvent[] = [];
    const onToolResult = vi.fn();
    const postToolCall = vi.fn();
    const hooks = new HookRegistry();
    hooks.register({ name: 'spy', postToolCall });

    const result = await AgentExecutor.execute({
      agent,
      input: 'go',
      provider,
      toolRegistry,
      hooks,
      onToolResult,
      onAgentEvent: e => events.push(e),
    });

    expect(result.text).toBe('done');
    const toolMessage = seenMessages[1].find(m => m.role === 'tool');
    expect(toolMessage!.toolCallId).toBe('call-1');
    expect(JSON.parse(toolMessage!.content)).toEqual({
      error: 'TypeError',
      toolName: 'boom',
      message: 'query must not be empty',
      kind: 'execution',
    });
    // The follow-up call succeeded.
    const secondTools = seenMessages[2].filter(m => m.role === 'tool');
    expect(JSON.parse(secondTools[1].content)).toEqual({ ok: true });

    // Events and callbacks still see an error.
    const toolErrors = events.filter(e => e.type === 'tool.error');
    expect(toolErrors[0].error.message).toBe('query must not be empty');
    expect(onToolResult.mock.calls[0][1].error).toBe('query must not be empty');
    expect(postToolCall.mock.calls[0][1].error).toBe('query must not be empty');
  });

  it('truncates very long messages', async () => {
    const { toolRegistry, agent } = setup(async () => {
      throw new Error('x'.repeat(10_000));
    });
    const { provider, seenMessages } = scriptedProvider(1);

    await AgentExecutor.execute({ agent, input: 'go', provider, toolRegistry });

    const payload = JSON.parse(seenMessages[1].find(m => m.role === 'tool')!.content);
    expect(payload.message.length).toBe(2000 + '... (truncated)'.length);
    expect(payload.message.endsWith('... (truncated)')).toBe(true);
  });

  it('falls back to a generic name for non-Error throws', async () => {
    const { toolRegistry, agent } = setup(async () => {
      throw 'plain string';
    });
    const { provider, seenMessages } = scriptedProvider(1);

    await AgentExecutor.execute({ agent, input: 'go', provider, toolRegistry });

    const payload = JSON.parse(seenMessages[1].find(m => m.role === 'tool')!.content);
    expect(payload).toEqual({ error: 'Error', toolName: 'boom', message: 'plain string', kind: 'execution' });
  });

  it('still aborts the run on a PropagatingToolError', async () => {
    const { toolRegistry, agent } = setup(async () => {
      throw new PropagatingToolError('stop everything');
    });
    const { provider } = scriptedProvider(1);

    await expect(
      AgentExecutor.execute({ agent, input: 'go', provider, toolRegistry })
    ).rejects.toThrow('stop everything');
  });
});
