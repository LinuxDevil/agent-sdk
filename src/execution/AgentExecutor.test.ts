import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentExecutor, ExecutionEvent } from './AgentExecutor';
import { createMockProvider } from '../providers/mock';
import { ToolRegistry } from '../tools';
import { AgentBuilder } from '../core';
import { AgentType } from '../types';

describe('AgentExecutor', () => {
  let provider: ReturnType<typeof createMockProvider>;
  let toolRegistry: ToolRegistry;

  beforeEach(() => {
    provider = createMockProvider({
      name: 'mock',
      responses: ['Hello! How can I help you today?'],
    });

    toolRegistry = new ToolRegistry();
  });

  describe('execute', () => {
    it('should execute simple agent', async () => {
      const agent = AgentBuilder.create()
        .setType(AgentType.SmartAssistant)
        .setName('Test Agent')
        .setPrompt('You are a helpful assistant')
        .build();

      const result = await AgentExecutor.execute({
        agent,
        input: 'Hello',
        provider,
      });

      expect(result.text).toBeDefined();
      expect(result.messages.length).toBeGreaterThan(0);
      expect(result.usage.totalTokens).toBeGreaterThan(0);
      expect(result.finishReason).toBeDefined();
      expect(result.steps).toBeGreaterThan(0);
    });

    it('should handle string input', async () => {
      const agent = AgentBuilder.create()
        .setType(AgentType.SmartAssistant)
        .setName('Test Agent')
        .setPrompt('You are helpful')
        .build();

      const result = await AgentExecutor.execute({
        agent,
        input: 'What is 2+2?',
        provider,
      });

      expect(result.text).toBe('Hello! How can I help you today?');
    });

    it('should handle message array input', async () => {
      const agent = AgentBuilder.create()
        .setType(AgentType.SmartAssistant)
        .setName('Test Agent')
        .build();

      const result = await AgentExecutor.execute({
        agent,
        input: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi!' },
          { role: 'user', content: 'How are you?' },
        ],
        provider,
      });

      expect(result.text).toBeDefined();
    });

    it('should emit events', async () => {
      const agent = AgentBuilder.create()
        .setType(AgentType.SmartAssistant)
        .setName('Test Agent')
        .build();

      const events: ExecutionEvent[] = [];

      await AgentExecutor.execute({
        agent,
        input: 'Hello',
        provider,
        onEvent: (event) => events.push(event),
      });

      expect(events.length).toBeGreaterThan(0);
      expect(events[0].type).toBe('start');
      expect(events[events.length - 1].type).toBe('finish');
    });

    it('should handle tool calls', async () => {
      // Register a mock tool using 'ai' SDK format
      const { tool } = await import('ai');
      const { z } = await import('zod');
      
      toolRegistry.register('getCurrentDate', {
        displayName: 'Get Current Date',
        tool: tool({
          description: 'Get the current date',
          parameters: z.object({}),
          execute: async () => ({ date: '2025-01-01' }),
        }),
      });

      const agent = AgentBuilder.create()
        .setType(AgentType.SmartAssistant)
        .setName('Test Agent')
        .addTool('getCurrentDate', { tool: 'getCurrentDate', options: {} })
        .build();

      // Use provider that simulates tool call
      const toolProvider = createMockProvider({
        name: 'mock',
        responses: ['The current date is 2025-01-01'],
      });

      const result = await AgentExecutor.execute({
        agent,
        input: 'Call the getCurrentDate function',
        provider: toolProvider,
        toolRegistry,
      });

      expect(result.text).toBeDefined();
    });

    it('should respect maxSteps', async () => {
      const agent = AgentBuilder.create()
        .setType(AgentType.SmartAssistant)
        .setName('Test Agent')
        .build();

      const result = await AgentExecutor.execute({
        agent,
        input: 'Hello',
        provider,
        maxSteps: 1,
      });

      expect(result.steps).toBe(1);
    });

    it('should handle errors', async () => {
      const errorProvider = createMockProvider({
        name: 'mock',
        simulateError: true,
        errorMessage: 'Test error',
      });

      const agent = AgentBuilder.create()
        .setType(AgentType.SmartAssistant)
        .setName('Test Agent')
        .build();

      await expect(
        AgentExecutor.execute({
          agent,
          input: 'Hello',
          provider: errorProvider,
        })
      ).rejects.toThrow('Test error');
    });

    it('should accumulate token usage', async () => {
      const agent = AgentBuilder.create()
        .setType(AgentType.SmartAssistant)
        .setName('Test Agent')
        .build();

      const result = await AgentExecutor.execute({
        agent,
        input: 'Hello',
        provider,
      });

      expect(result.usage.promptTokens).toBeGreaterThan(0);
      expect(result.usage.completionTokens).toBeGreaterThan(0);
      expect(result.usage.totalTokens).toBe(
        result.usage.promptTokens + result.usage.completionTokens
      );
    });

    it('should include system prompt', async () => {
      const agent = AgentBuilder.create()
        .setType(AgentType.SmartAssistant)
        .setName('Test Agent')
        .setPrompt('You are a pirate')
        .build();

      const result = await AgentExecutor.execute({
        agent,
        input: 'Hello',
        provider,
      });

      // Check that system message is in messages
      const systemMessage = result.messages.find(m => m.role === 'system');
      expect(systemMessage).toBeDefined();
      expect(systemMessage?.content).toBe('You are a pirate');
    });

    it('should not invoke a tool flagged with needsApproval, evaluated with actual args', async () => {
      const execute = vi.fn().mockResolvedValue({ ok: true });
      const needsApproval = vi.fn((args: any) => args.amount > 100);

      toolRegistry.register('chargeCard', {
        displayName: 'Charge Card',
        tool: { execute } as any,
        needsApproval,
      });

      const agent = AgentBuilder.create()
        .setType(AgentType.SmartAssistant)
        .setName('Test Agent')
        .build();

      const toolCall = {
        id: 'call-1',
        type: 'function' as const,
        function: {
          name: 'chargeCard',
          arguments: JSON.stringify({ amount: 500 }),
        },
      };

      const result = await (AgentExecutor as any).executeToolCall(
        toolCall,
        agent,
        toolRegistry
      );

      expect(execute).not.toHaveBeenCalled();
      expect(needsApproval).toHaveBeenCalledWith({ amount: 500 });
      expect(result.requiresApproval).toBe(true);
      expect(result.args).toEqual({ amount: 500 });
    });

    it('should leave unflagged tools unchanged', async () => {
      const execute = vi.fn().mockResolvedValue({ ok: true });

      toolRegistry.register('chargeCard', {
        displayName: 'Charge Card',
        tool: { execute } as any,
      });

      const agent = AgentBuilder.create()
        .setType(AgentType.SmartAssistant)
        .setName('Test Agent')
        .build();

      const toolCall = {
        id: 'call-2',
        type: 'function' as const,
        function: {
          name: 'chargeCard',
          arguments: JSON.stringify({ amount: 5 }),
        },
      };

      const result = await (AgentExecutor as any).executeToolCall(
        toolCall,
        agent,
        toolRegistry
      );

      expect(execute).toHaveBeenCalledWith({ amount: 5 }, {});
      expect(result.requiresApproval).toBeUndefined();
      expect(result.result).toEqual({ ok: true });
    });

    it('should pause and persist a snapshot when a tool needs approval', async () => {
      const execute = vi.fn().mockResolvedValue({ ok: true });

      toolRegistry.register('chargeCard', {
        displayName: 'Charge Card',
        tool: {
          description: 'Charge a card',
          parameters: {},
          execute,
        } as any,
        needsApproval: true,
      });

      const agent = AgentBuilder.create()
        .setType(AgentType.SmartAssistant)
        .setName('Test Agent')
        .addTool('chargeCard', { tool: 'chargeCard', options: {} })
        .build();

      // MockLLMProvider simulates a tool call when the last user message
      // mentions the tool's name.
      const approvalProvider = createMockProvider({
        name: 'mock',
        responses: ['Charging your card now'],
      });

      const save = vi.fn().mockResolvedValue(undefined);
      const resolve = vi.fn().mockResolvedValue(null);

      const result = await AgentExecutor.execute({
        agent,
        input: 'Please call chargeCard now',
        provider: approvalProvider,
        toolRegistry,
        approvalStore: { save, resolve },
      });

      expect(execute).not.toHaveBeenCalled();
      expect(result.finishReason).toBe('awaiting-approval');
      expect(result.approvalId).toBeDefined();
      expect(save).toHaveBeenCalledTimes(1);

      const [pendingArg, snapshotArg] = save.mock.calls[0];
      expect(pendingArg.toolName).toBe('chargeCard');
      expect(pendingArg.args).toEqual({ input: 'mock input' });
      expect(snapshotArg.currentMessages).toEqual(result.messages);
      expect(snapshotArg.currentMessages.some((m: any) => m.role === 'user')).toBe(true);
    });

    it('should throw a clear error when approval is needed but no approvalStore is provided', async () => {
      const execute = vi.fn().mockResolvedValue({ ok: true });

      toolRegistry.register('chargeCard', {
        displayName: 'Charge Card',
        tool: {
          description: 'Charge a card',
          parameters: {},
          execute,
        } as any,
        needsApproval: true,
      });

      const agent = AgentBuilder.create()
        .setType(AgentType.SmartAssistant)
        .setName('Test Agent')
        .addTool('chargeCard', { tool: 'chargeCard', options: {} })
        .build();

      const approvalProvider = createMockProvider({
        name: 'mock',
        responses: ['Charging your card now'],
      });

      await expect(
        AgentExecutor.execute({
          agent,
          input: 'Please call chargeCard now',
          provider: approvalProvider,
          toolRegistry,
        })
      ).rejects.toThrow(/requires approval/);
    });

    it('should save a checkpoint after each tool result when sessionId + checkpointStore are provided', async () => {
      const execute = vi.fn().mockResolvedValue({ ok: true });
      toolRegistry.register('noop', {
        displayName: 'Noop',
        tool: { description: 'noop', parameters: {}, execute } as any,
      });

      const agent = AgentBuilder.create()
        .setType(AgentType.SmartAssistant)
        .setName('Test Agent')
        .addTool('noop', { tool: 'noop', options: {} })
        .build();

      // Custom provider: emits a tool call for the first 3 generations,
      // then stops.
      let call = 0;
      const scriptedProvider = {
        name: 'scripted',
        supportsTools: () => true,
        supportsStreaming: () => false,
        getModels: async () => ['scripted'],
        stream: async () => {
          throw new Error('not implemented');
        },
        generate: async () => {
          call++;
          if (call <= 3) {
            return {
              text: `step ${call}`,
              finishReason: 'tool_calls' as const,
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              toolCalls: [
                {
                  id: `call-${call}`,
                  type: 'function' as const,
                  function: { name: 'noop', arguments: '{}' },
                },
              ],
            };
          }
          return {
            text: 'done',
            finishReason: 'stop' as const,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          };
        },
      };

      const save = vi.fn().mockResolvedValue(undefined);
      const checkpointStore = { save, load: vi.fn(), delete: vi.fn() };

      await AgentExecutor.execute({
        agent,
        input: 'go',
        provider: scriptedProvider as any,
        toolRegistry,
        sessionId: 'session-checkpoint-test',
        checkpointStore,
      });

      expect(save).toHaveBeenCalledTimes(3);
      const lengths = save.mock.calls.map(([, checkpoint]) => checkpoint.messages.length);
      expect(lengths[1]).toBeGreaterThan(lengths[0]);
      expect(lengths[2]).toBeGreaterThan(lengths[1]);
    });

    it('should resume from a checkpoint after a simulated crash + restart with zero message loss', async () => {
      const execute = vi.fn().mockResolvedValue({ ok: true });
      toolRegistry.register('noop', {
        displayName: 'Noop',
        tool: { description: 'noop', parameters: {}, execute } as any,
      });

      const agent = AgentBuilder.create()
        .setType(AgentType.SmartAssistant)
        .setName('Test Agent')
        .addTool('noop', { tool: 'noop', options: {} })
        .build();

      function makeCheckpointStore() {
        const records = new Map<string, any>();
        return {
          save: vi.fn(async (sessionId: string, checkpoint: any) => {
            records.set(sessionId, checkpoint);
          }),
          load: vi.fn(async (sessionId: string) => records.get(sessionId) ?? null),
          delete: vi.fn(async (sessionId: string) => {
            records.delete(sessionId);
          }),
        };
      }

      function toolCallResponse(callNumber: number) {
        return {
          text: `step ${callNumber}`,
          finishReason: 'tool_calls' as const,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          toolCalls: [
            {
              id: `call-${callNumber}`,
              type: 'function' as const,
              function: { name: 'noop', arguments: '{}' },
            },
          ],
        };
      }

      function stopResponse() {
        return {
          text: 'done',
          finishReason: 'stop' as const,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      }

      // --- "Uninterrupted" baseline run: all 4 tool calls in one go ---
      const baselineStore = makeCheckpointStore();
      let baselineCall = 0;
      const baselineProvider = {
        name: 'scripted',
        supportsTools: () => true,
        supportsStreaming: () => false,
        getModels: async () => ['scripted'],
        stream: async () => {
          throw new Error('not implemented');
        },
        generate: async () => {
          baselineCall++;
          return baselineCall <= 4 ? toolCallResponse(baselineCall) : stopResponse();
        },
      };

      const baselineResult = await AgentExecutor.execute({
        agent,
        input: 'go',
        provider: baselineProvider as any,
        toolRegistry,
        sessionId: 'baseline-session',
        checkpointStore: baselineStore,
      });

      // --- Interrupted run: crashes after 2 of 4 tool calls ---
      const sharedStore = makeCheckpointStore();
      let crashCall = 0;
      const crashingProvider = {
        name: 'scripted-crash',
        supportsTools: () => true,
        supportsStreaming: () => false,
        getModels: async () => ['scripted-crash'],
        stream: async () => {
          throw new Error('not implemented');
        },
        generate: async () => {
          crashCall++;
          if (crashCall <= 2) {
            return toolCallResponse(crashCall);
          }
          throw new Error('simulated crash');
        },
      };

      await expect(
        AgentExecutor.execute({
          agent,
          input: 'go',
          provider: crashingProvider as any,
          toolRegistry,
          sessionId: 'resume-session',
          checkpointStore: sharedStore,
        })
      ).rejects.toThrow('simulated crash');

      // "Restart": a brand new execute() call with the same sessionId/store,
      // completing the remaining tool calls.
      let resumeCall = 0;
      const resumeProvider = {
        name: 'scripted-resume',
        supportsTools: () => true,
        supportsStreaming: () => false,
        getModels: async () => ['scripted-resume'],
        stream: async () => {
          throw new Error('not implemented');
        },
        generate: async () => {
          resumeCall++;
          return resumeCall <= 2 ? toolCallResponse(2 + resumeCall) : stopResponse();
        },
      };

      const resumedResult = await AgentExecutor.execute({
        agent,
        input: 'go',
        provider: resumeProvider as any,
        toolRegistry,
        sessionId: 'resume-session',
        checkpointStore: sharedStore,
      });

      expect(sharedStore.load).toHaveBeenCalledWith('resume-session');
      expect(resumedResult.messages).toHaveLength(baselineResult.messages.length);
    });

    it('should build messages from scratch when no checkpoint exists for a fresh sessionId', async () => {
      const checkpointStore = {
        save: vi.fn().mockResolvedValue(undefined),
        load: vi.fn().mockResolvedValue(null),
        delete: vi.fn().mockResolvedValue(undefined),
      };

      const agent = AgentBuilder.create()
        .setType(AgentType.SmartAssistant)
        .setName('Test Agent')
        .setPrompt('You are a pirate')
        .build();

      const result = await AgentExecutor.execute({
        agent,
        input: 'Hello',
        provider,
        sessionId: 'fresh-session',
        checkpointStore,
      });

      expect(checkpointStore.load).toHaveBeenCalledWith('fresh-session');
      const systemMessage = result.messages.find((m) => m.role === 'system');
      expect(systemMessage?.content).toBe('You are a pirate');
      const userMessage = result.messages.find((m) => m.role === 'user');
      expect(userMessage?.content).toBe('Hello');
    });

    it('should pass temperature and maxTokens', async () => {
      const agent = AgentBuilder.create()
        .setType(AgentType.SmartAssistant)
        .setName('Test Agent')
        .build();

      const result = await AgentExecutor.execute({
        agent,
        input: 'Hello',
        provider,
        temperature: 0.7,
        maxTokens: 100,
      });

      expect(result.text).toBeDefined();
    });
  });
});
