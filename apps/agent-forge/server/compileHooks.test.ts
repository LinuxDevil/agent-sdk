import { describe, expect, it, vi } from 'vitest';
import { AgentExecutor, NoopSandbox, ToolRegistry, AgentBuilder, AgentType, createMockProvider } from '@loushy/build-ai-agent';
import { compileHooksFromSpecPolicy, isSerializedHookList, type SerializedHook } from './compileHooks';

describe('isSerializedHookList', () => {
  it('accepts a well-shaped array', () => {
    const value: SerializedHook[] = [
      { nodeKey: 'llm', id: 'h1', name: 'x', phase: 'pre', point: 'generate', code: 'return ctx;' },
    ];
    expect(isSerializedHookList(value)).toBe(true);
  });

  it('rejects anything else without throwing', () => {
    expect(isSerializedHookList(undefined)).toBe(false);
    expect(isSerializedHookList('nope')).toBe(false);
    expect(isSerializedHookList([{ nodeKey: 'llm' }])).toBe(false);
  });
});

describe('compileHooksFromSpecPolicy', () => {
  it('returns undefined for no/empty hooks', () => {
    expect(compileHooksFromSpecPolicy(undefined, NoopSandbox)).toBeUndefined();
    expect(compileHooksFromSpecPolicy([], NoopSandbox)).toBeUndefined();
  });

  it('compiles a preToolCall hook that actually redacts tool-call args when the agent runs', async () => {
    const hooks: SerializedHook[] = [
      {
        nodeKey: 'tool:sendEmail',
        id: 'redact-pii-1',
        name: 'redact-pii',
        phase: 'pre',
        point: 'toolCall',
        code: 'ctx.args.email = "[REDACTED]"; return ctx;',
      },
    ];
    const registry = compileHooksFromSpecPolicy(hooks, NoopSandbox);
    expect(registry).toBeDefined();
    expect(registry!.size()).toBe(1);

    const execute = vi.fn();
    const toolRegistry = new ToolRegistry();
    toolRegistry.register('sendEmail', {
      displayName: 'Send Email',
      tool: { description: 'send', parameters: {}, execute } as any,
    });

    const agent = AgentBuilder.create()
      .setType(AgentType.SmartAssistant)
      .setName('Test Agent')
      .addTool('sendEmail', { tool: 'sendEmail', options: {} })
      .build();

    const scriptedProvider = {
      name: 'scripted',
      supportsTools: () => true,
      supportsStreaming: () => false,
      getModels: async () => ['scripted'],
      stream: async () => {
        throw new Error('not implemented');
      },
      generate: async () => ({
        text: '',
        finishReason: 'tool_calls' as const,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        toolCalls: [
          {
            id: 'call-1',
            type: 'function' as const,
            function: { name: 'sendEmail', arguments: JSON.stringify({ email: 'real@example.com' }) },
          },
        ],
      }),
    };

    await AgentExecutor.execute({
      agent,
      input: 'send it',
      provider: scriptedProvider as any,
      toolRegistry,
      hooks: registry,
      maxSteps: 1,
    });

    expect(execute).toHaveBeenCalledWith({ email: '[REDACTED]' }, {});
  });

  it('compiles a preGenerate hook that actually injects a message when the agent runs', async () => {
    const hooks: SerializedHook[] = [
      {
        nodeKey: 'llm',
        id: 'inject-context-1',
        name: 'inject-context',
        phase: 'pre',
        point: 'generate',
        code: 'ctx.messages.push({ role: "system", content: "injected" }); return ctx;',
      },
    ];
    const registry = compileHooksFromSpecPolicy(hooks, NoopSandbox);

    const provider = createMockProvider({ name: 'mock', responses: ['ok'] });
    const generateSpy = vi.fn(provider.generate.bind(provider));
    const spiedProvider = { ...provider, generate: generateSpy };

    const agent = AgentBuilder.create().setType(AgentType.SmartAssistant).setName('Test Agent').build();

    await AgentExecutor.execute({
      agent,
      input: 'hello',
      provider: spiedProvider as any,
      hooks: registry,
    });

    const sentMessages = generateSpy.mock.calls[0][0].messages;
    expect(sentMessages.some((m: any) => m.content === 'injected')).toBe(true);
  });
});
