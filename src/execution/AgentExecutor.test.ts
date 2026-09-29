import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentExecutor, ExecutionEvent } from './AgentExecutor';
import { createMockProvider } from '../providers/mock';
import { ToolRegistry } from '../tools';
import { AgentBuilder } from '../core';
import { AgentType } from '../types';
import { Span, TraceExporter } from './tracing';

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

    it('should write the businessState option into every checkpoint record (LOU-T1)', async () => {
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
          if (call <= 2) {
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
      const checkpointStore = { save, load: vi.fn().mockResolvedValue(null), delete: vi.fn() };

      await AgentExecutor.execute({
        agent,
        input: 'go',
        provider: scriptedProvider as any,
        toolRegistry,
        sessionId: 'session-business-state',
        checkpointStore,
        businessState: { orderId: 'ord_42', stage: 'processing' },
      });

      expect(save).toHaveBeenCalledTimes(2);
      for (const [, checkpoint] of save.mock.calls) {
        expect(checkpoint.businessState).toEqual({ orderId: 'ord_42', stage: 'processing' });
      }
    });

    it('should leave checkpoint.businessState undefined when the option is omitted - backward compatible (LOU-T1)', async () => {
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

      const scriptedProvider = {
        name: 'scripted',
        supportsTools: () => true,
        supportsStreaming: () => false,
        getModels: async () => ['scripted'],
        stream: async () => {
          throw new Error('not implemented');
        },
        generate: async () => ({
          text: 'step',
          finishReason: 'tool_calls' as const,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          toolCalls: [
            { id: 'call-1', type: 'function' as const, function: { name: 'noop', arguments: '{}' } },
          ],
        }),
      };

      const save = vi.fn().mockResolvedValue(undefined);
      const checkpointStore = { save, load: vi.fn().mockResolvedValue(null), delete: vi.fn() };

      // Only one step so the run doesn't loop forever with the always-tool-calls provider.
      await expect(
        AgentExecutor.execute({
          agent,
          input: 'go',
          provider: scriptedProvider as any,
          toolRegistry,
          sessionId: 'session-no-business-state',
          checkpointStore,
          maxSteps: 1,
        })
      ).resolves.toBeDefined();

      expect(save).toHaveBeenCalledTimes(1);
      expect(save.mock.calls[0][1].businessState).toBeUndefined();
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

    it('should carry businessState through a crash + restart without the resumed call re-passing it (LOU-T1)', async () => {
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
          if (crashCall <= 1) {
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
          sessionId: 'resume-session-bs',
          checkpointStore: sharedStore,
          businessState: { ticketId: 'tix_9', stage: 'in-progress' },
        })
      ).rejects.toThrow('simulated crash');

      // Confirm the pre-crash checkpoint really has businessState attached
      // (proves the field survived the "crash" - i.e. was durably written -
      // rather than only ever living in in-memory options).
      const staleCheckpoint = await sharedStore.load('resume-session-bs');
      expect(staleCheckpoint.businessState).toEqual({ ticketId: 'tix_9', stage: 'in-progress' });

      // "Restart": a brand new execute() call, same sessionId/store, that
      // does NOT re-pass businessState - it must be rehydrated from the
      // checkpoint written before the crash.
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
          return resumeCall <= 1 ? toolCallResponse(1 + resumeCall) : stopResponse();
        },
      };

      await AgentExecutor.execute({
        agent,
        input: 'go',
        provider: resumeProvider as any,
        toolRegistry,
        sessionId: 'resume-session-bs',
        checkpointStore: sharedStore,
      });

      // The run finished (terminal finishReason), so AgentExecutor deletes
      // the checkpoint - but every intermediate save during the resumed run
      // must have carried the rehydrated businessState forward untouched.
      const businessStatesWritten = sharedStore.save.mock.calls
        .filter(([sessionId]) => sessionId === 'resume-session-bs')
        .map(([, checkpoint]) => checkpoint.businessState);
      expect(businessStatesWritten.length).toBeGreaterThan(0);
      for (const bs of businessStatesWritten) {
        expect(bs).toEqual({ ticketId: 'tix_9', stage: 'in-progress' });
      }
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

    it('should delete the checkpoint once a run reaches a terminal finish reason', async () => {
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
          if (call === 1) {
            return {
              text: 'calling noop',
              finishReason: 'tool_calls' as const,
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              toolCalls: [
                {
                  id: 'call-1',
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

      const checkpointStore = makeCheckpointStore();

      await AgentExecutor.execute({
        agent,
        input: 'go',
        provider: scriptedProvider as any,
        toolRegistry,
        sessionId: 'terminal-session',
        checkpointStore,
      });

      expect(checkpointStore.delete).toHaveBeenCalledWith('terminal-session');
      await expect(checkpointStore.load('terminal-session')).resolves.toBeNull();
    });

    it('should use fresh input (not stale stored messages) when execute() is called again with the same sessionId after completion', async () => {
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

      const checkpointStore = makeCheckpointStore();
      const agent = AgentBuilder.create()
        .setType(AgentType.SmartAssistant)
        .setName('Test Agent')
        .build();

      // First run: completes normally (no tool calls), reaching a terminal
      // finish reason and clearing the checkpoint.
      const firstProvider = createMockProvider({
        name: 'mock',
        responses: ['first response'],
      });

      await AgentExecutor.execute({
        agent,
        input: 'first input',
        provider: firstProvider,
        sessionId: 'reused-session',
        checkpointStore,
      });

      // Second run: same sessionId, brand-new input. If the stale checkpoint
      // were still around and rehydrated, this fresh input would be
      // silently ignored.
      const secondProvider = createMockProvider({
        name: 'mock',
        responses: ['second response'],
      });

      const secondResult = await AgentExecutor.execute({
        agent,
        input: 'second input, completely different',
        provider: secondProvider,
        sessionId: 'reused-session',
        checkpointStore,
      });

      const userMessage = secondResult.messages.find((m) => m.role === 'user');
      expect(userMessage?.content).toBe('second input, completely different');
      expect(secondResult.text).toBe('second response');
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

  describe('tracing hooks (LOU-E2)', () => {
    it('invokes onLLMRequest/onLLMResponse and onToolCall/onToolResult in order, with real latency', async () => {
      const { tool } = await import('ai');
      const { z } = await import('zod');

      toolRegistry.register('slowTool', {
        displayName: 'Slow Tool',
        tool: tool({
          description: 'A tool with an artificial delay',
          parameters: z.object({}),
          execute: async () => {
            await new Promise((resolve) => setTimeout(resolve, 30));
            return { ok: true };
          },
        }),
      });

      const agent = AgentBuilder.create()
        .setType(AgentType.SmartAssistant)
        .setName('Test Agent')
        .addTool('slowTool', { tool: 'slowTool', options: {} })
        .build();

      let callCount = 0;
      const mockProvider = {
        name: 'mock',
        async generate(options: any) {
          callCount++;
          if (callCount === 1) {
            return {
              text: '',
              finishReason: 'tool_calls' as const,
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              toolCalls: [
                {
                  id: 'call-1',
                  type: 'function' as const,
                  function: { name: 'slowTool', arguments: '{}' },
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
        async stream() {
          throw new Error('not implemented');
        },
        supportsTools: () => true,
        supportsStreaming: () => false,
        async getModels() {
          return [];
        },
      };

      const onLLMRequest = vi.fn();
      const onLLMResponse = vi.fn();
      const onToolCall = vi.fn();
      const onToolResult = vi.fn();

      const order: string[] = [];
      onLLMRequest.mockImplementation(() => order.push('llm-request'));
      onLLMResponse.mockImplementation(() => order.push('llm-response'));
      onToolCall.mockImplementation(() => order.push('tool-call'));
      onToolResult.mockImplementation(() => order.push('tool-result'));

      await AgentExecutor.execute({
        agent,
        input: 'please call slowTool',
        provider: mockProvider as any,
        toolRegistry,
        onLLMRequest,
        onLLMResponse,
        onToolCall,
        onToolResult,
      });

      expect(onLLMRequest).toHaveBeenCalledTimes(2);
      expect(onLLMResponse).toHaveBeenCalledTimes(2);
      expect(onToolCall).toHaveBeenCalledTimes(1);
      expect(onToolResult).toHaveBeenCalledTimes(1);

      // Order: request -> response for step 1, then the tool call/result,
      // then request -> response for step 2.
      expect(order).toEqual([
        'llm-request',
        'llm-response',
        'tool-call',
        'tool-result',
        'llm-request',
        'llm-response',
      ]);

      expect(onToolCall).toHaveBeenCalledWith(
        expect.objectContaining({ function: expect.objectContaining({ name: 'slowTool' }) })
      );

      // Latency should be a real positive number, reflecting the tool's
      // artificial 30ms delay.
      const toolResultLatency = onToolResult.mock.calls[0][2];
      expect(typeof toolResultLatency).toBe('number');
      expect(toolResultLatency).toBeGreaterThan(0);

      const llmResponseLatency = onLLMResponse.mock.calls[0][1];
      expect(typeof llmResponseLatency).toBe('number');
      expect(llmResponseLatency).toBeGreaterThanOrEqual(0);
    });

    it('propagates errors thrown by a hook callback', async () => {
      const agent = AgentBuilder.create()
        .setType(AgentType.SmartAssistant)
        .setName('Test Agent')
        .build();

      await expect(
        AgentExecutor.execute({
          agent,
          input: 'Hello',
          provider,
          onLLMRequest: () => {
            throw new Error('hook boom');
          },
        })
      ).rejects.toThrow('hook boom');
    });

    it('fires onToolResult even when the tool execution throws', async () => {
      const { tool } = await import('ai');
      const { z } = await import('zod');

      toolRegistry.register('failingTool', {
        displayName: 'Failing Tool',
        tool: tool({
          description: 'A tool that always fails',
          parameters: z.object({}),
          execute: async () => {
            throw new Error('tool exploded');
          },
        }),
      });

      const agent = AgentBuilder.create()
        .setType(AgentType.SmartAssistant)
        .setName('Test Agent')
        .addTool('failingTool', { tool: 'failingTool', options: {} })
        .build();

      let callCount = 0;
      const mockProvider = {
        name: 'mock',
        async generate() {
          callCount++;
          if (callCount === 1) {
            return {
              text: '',
              finishReason: 'tool_calls' as const,
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              toolCalls: [
                {
                  id: 'call-1',
                  type: 'function' as const,
                  function: { name: 'failingTool', arguments: '{}' },
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
        async stream() {
          throw new Error('not implemented');
        },
        supportsTools: () => true,
        supportsStreaming: () => false,
        async getModels() {
          return [];
        },
      };

      const onToolResult = vi.fn();

      const result = await AgentExecutor.execute({
        agent,
        input: 'please call failingTool',
        provider: mockProvider as any,
        toolRegistry,
        onToolResult,
      });

      // The tool's error is swallowed into a conversational {error}
      // tool-result (not a PropagatingToolError), so execute() itself
      // completes rather than rejecting - but onToolResult must still
      // have fired for that failed execution.
      expect(result.text).toBe('done');
      expect(onToolResult).toHaveBeenCalledTimes(1);
      const [, toolResultArg, latencyMs] = onToolResult.mock.calls[0];
      expect(toolResultArg?.error).toContain('tool exploded');
      expect(typeof latencyMs).toBe('number');
      expect(latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('withSpan tracing (LOU-E5)', () => {
    function createSpyExporter() {
      const starts: Span[] = [];
      const ends: Span[] = [];
      const exporter: TraceExporter = {
        onSpanStart: vi.fn((span: Span) => starts.push({ ...span })),
        onSpanEnd: vi.fn((span: Span) => ends.push({ ...span })),
      };
      return { exporter, starts, ends };
    }

    function buildToolAgentAndProvider() {
      let callCount = 0;
      const mockProvider = {
        name: 'mock',
        async generate() {
          callCount++;
          if (callCount === 1) {
            return {
              text: '',
              finishReason: 'tool_calls' as const,
              usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
              toolCalls: [
                {
                  id: 'call-1',
                  type: 'function' as const,
                  function: { name: 'echoTool', arguments: '{"msg":"secret-value"}' },
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
        async stream() {
          throw new Error('not implemented');
        },
        supportsTools: () => true,
        supportsStreaming: () => false,
        async getModels() {
          return [];
        },
      };
      return mockProvider;
    }

    it('produces a 3-level span tree: agent.run -> llm.generate, tool.call, with correct parent/child ids', async () => {
      const { tool } = await import('ai');
      const { z } = await import('zod');

      toolRegistry.register('echoTool', {
        displayName: 'Echo Tool',
        tool: tool({
          description: 'Echoes its input',
          parameters: z.object({ msg: z.string() }),
          execute: async ({ msg }) => ({ echoed: msg }),
        }),
      });

      const agent = AgentBuilder.create()
        .setType(AgentType.SmartAssistant)
        .setName('Test Agent')
        .addTool('echoTool', { tool: 'echoTool', options: {} })
        .build();

      const { exporter, starts, ends } = createSpyExporter();

      await AgentExecutor.execute({
        agent,
        input: 'please call echoTool',
        provider: buildToolAgentAndProvider() as any,
        toolRegistry,
        exporter,
      });

      const names = starts.map((s) => s.name);
      expect(names).toEqual(['agent.run', 'llm.generate', 'tool.call', 'llm.generate']);
      expect(starts).toHaveLength(4);
      expect(ends).toHaveLength(4);

      const agentRunSpan = starts.find((s) => s.name === 'agent.run')!;
      const llmSpans = starts.filter((s) => s.name === 'llm.generate');
      const toolSpan = starts.find((s) => s.name === 'tool.call')!;

      expect(agentRunSpan.parentId).toBeUndefined();
      for (const llmSpan of llmSpans) {
        expect(llmSpan.parentId).toBe(agentRunSpan.id);
      }
      expect(toolSpan.parentId).toBe(agentRunSpan.id);
    });

    it('includes content in span attributes by default (redactContent omitted)', async () => {
      const { tool } = await import('ai');
      const { z } = await import('zod');

      toolRegistry.register('echoTool', {
        displayName: 'Echo Tool',
        tool: tool({
          description: 'Echoes its input',
          parameters: z.object({ msg: z.string() }),
          execute: async ({ msg }) => ({ echoed: msg }),
        }),
      });

      const agent = AgentBuilder.create()
        .setType(AgentType.SmartAssistant)
        .setName('Test Agent')
        .addTool('echoTool', { tool: 'echoTool', options: {} })
        .build();

      const { exporter, ends } = createSpyExporter();

      await AgentExecutor.execute({
        agent,
        input: 'please call echoTool',
        provider: buildToolAgentAndProvider() as any,
        toolRegistry,
        exporter,
      });

      const serialized = JSON.stringify(ends);
      expect(serialized).toContain('secret-value');

      const llmSpan = ends.find((s) => s.name === 'llm.generate');
      expect(llmSpan?.attributes.prompt).toBeDefined();
      expect(llmSpan?.attributes.promptTokens).toBeDefined();
      expect(llmSpan?.attributes.finishReason).toBeDefined();

      const toolSpan = ends.find((s) => s.name === 'tool.call');
      expect(toolSpan?.attributes.args).toBeDefined();
      expect(toolSpan?.attributes.result).toBeDefined();
      expect(toolSpan?.attributes.error).toBe(false);
      expect(typeof toolSpan?.attributes.latencyMs).toBe('number');
    });

    it('omits content from span attributes when redactContent is true, while keeping non-content fields', async () => {
      const { tool } = await import('ai');
      const { z } = await import('zod');

      toolRegistry.register('echoTool', {
        displayName: 'Echo Tool',
        tool: tool({
          description: 'Echoes its input',
          parameters: z.object({ msg: z.string() }),
          execute: async ({ msg }) => ({ echoed: msg }),
        }),
      });

      const agent = AgentBuilder.create()
        .setType(AgentType.SmartAssistant)
        .setName('Test Agent')
        .addTool('echoTool', { tool: 'echoTool', options: {} })
        .build();

      const { exporter, ends } = createSpyExporter();

      await AgentExecutor.execute({
        agent,
        input: 'please call echoTool',
        provider: buildToolAgentAndProvider() as any,
        toolRegistry,
        exporter,
        redactContent: true,
      });

      const serialized = JSON.stringify(ends);
      expect(serialized).not.toContain('secret-value');

      const llmSpan = ends.find((s) => s.name === 'llm.generate');
      expect(llmSpan?.attributes.prompt).toBeUndefined();
      expect(llmSpan?.attributes.promptTokens).toBeDefined();
      expect(llmSpan?.attributes.finishReason).toBeDefined();

      const toolSpan = ends.find((s) => s.name === 'tool.call');
      expect(toolSpan?.attributes.args).toBeUndefined();
      expect(toolSpan?.attributes.result).toBeUndefined();
      expect(toolSpan?.attributes.error).toBe(false);
    });

    it('works without an exporter (execute() behaves as before)', async () => {
      const agent = AgentBuilder.create()
        .setType(AgentType.SmartAssistant)
        .setName('Test Agent')
        .build();

      const result = await AgentExecutor.execute({
        agent,
        input: 'Hello',
        provider,
      });

      expect(result.text).toBeDefined();
    });
  });

  describe('guiding runtime error messages (LOU-H12)', () => {
    it('throws naming "provider" with a corrective snippet when provider is omitted', async () => {
      const agent = AgentBuilder.create()
        .setType(AgentType.SmartAssistant)
        .setName('Test Agent')
        .build();

      await expect(
        AgentExecutor.execute({
          agent,
          input: 'Hello',
        } as any)
      ).rejects.toThrow(/'provider' is required.*Example:/s);
    });

    it('throws naming "agent" with a corrective snippet when agent is omitted', async () => {
      await expect(
        AgentExecutor.execute({
          input: 'Hello',
          provider,
        } as any)
      ).rejects.toThrow(/'agent' is required.*Example:/s);
    });

    it('throws naming "input" with a corrective snippet when input is omitted', async () => {
      const agent = AgentBuilder.create()
        .setType(AgentType.SmartAssistant)
        .setName('Test Agent')
        .build();

      await expect(
        AgentExecutor.execute({
          agent,
          provider,
        } as any)
      ).rejects.toThrow(/'input' is required.*Example:/s);
    });
  });

  describe('hooks (LOU-Q1)', () => {
    it('runs preGenerate and postGenerate around each provider.generate() call', async () => {
      const { HookRegistry } = await import('./hooks');
      const hooks = new HookRegistry();
      const events: string[] = [];
      hooks.register({
        name: 'observer',
        preGenerate: () => { events.push('pre'); },
        postGenerate: () => { events.push('post'); },
      });

      const agent = AgentBuilder.create()
        .setType(AgentType.SmartAssistant)
        .setName('Test Agent')
        .build();

      await AgentExecutor.execute({
        agent,
        input: 'Hello',
        provider,
        hooks,
      });

      expect(events).toEqual(['pre', 'post']);
    });

    it('a preGenerate hook can inject a message that is actually sent to the provider', async () => {
      const { HookRegistry } = await import('./hooks');
      const hooks = new HookRegistry();
      hooks.register({
        name: 'inject-context',
        preGenerate: (ctx) => {
          ctx.request.messages.push({ role: 'system', content: 'injected-by-hook' });
        },
      });

      const generateSpy = vi.fn(provider.generate.bind(provider));
      const spiedProvider = { ...provider, generate: generateSpy };

      const agent = AgentBuilder.create()
        .setType(AgentType.SmartAssistant)
        .setName('Test Agent')
        .build();

      await AgentExecutor.execute({
        agent,
        input: 'Hello',
        provider: spiedProvider as any,
        hooks,
      });

      const sentMessages = generateSpy.mock.calls[0][0].messages;
      expect(sentMessages.some((m: any) => m.content === 'injected-by-hook')).toBe(true);
    });

    it('runs preToolCall and postToolCall around tool execution, in registration order', async () => {
      const { HookRegistry } = await import('./hooks');
      const hooks = new HookRegistry();
      const events: string[] = [];
      hooks.register({
        name: 'first',
        preToolCall: () => { events.push('first:pre'); },
        postToolCall: () => { events.push('first:post'); },
      });
      hooks.register({
        name: 'second',
        preToolCall: () => { events.push('second:pre'); },
        postToolCall: () => { events.push('second:post'); },
      });

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

      let call = 0;
      const scriptedProvider = {
        name: 'scripted',
        supportsTools: () => true,
        supportsStreaming: () => false,
        getModels: async () => ['scripted'],
        stream: async () => { throw new Error('not implemented'); },
        generate: async () => {
          call++;
          if (call === 1) {
            return {
              text: '',
              finishReason: 'tool_calls' as const,
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              toolCalls: [
                { id: 'call-1', type: 'function' as const, function: { name: 'noop', arguments: '{}' } },
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

      await AgentExecutor.execute({
        agent,
        input: 'go',
        provider: scriptedProvider as any,
        toolRegistry,
        hooks,
      });

      expect(events).toEqual(['first:pre', 'second:pre', 'first:post', 'second:post']);
    });

    it('a preToolCall hook mutating ctx.args changes what the tool is actually invoked with (redact-pii style)', async () => {
      const { HookRegistry } = await import('./hooks');
      const hooks = new HookRegistry();
      hooks.register({
        name: 'redact-pii',
        preToolCall: (ctx) => {
          ctx.args.email = '[REDACTED]';
        },
      });

      const execute = vi.fn().mockResolvedValue({ ok: true });
      toolRegistry.register('sendEmail', {
        displayName: 'Send Email',
        tool: { description: 'send email', parameters: {}, execute } as any,
      });

      const agent = AgentBuilder.create()
        .setType(AgentType.SmartAssistant)
        .setName('Test Agent')
        .addTool('sendEmail', { tool: 'sendEmail', options: {} })
        .build();

      const toolCall = {
        id: 'call-1',
        type: 'function' as const,
        function: { name: 'sendEmail', arguments: JSON.stringify({ email: 'real@example.com' }) },
      };

      await (AgentExecutor as any).executeToolCall(toolCall, agent, toolRegistry, undefined, undefined, undefined, hooks, undefined, []);

      expect(execute).toHaveBeenCalledWith({ email: '[REDACTED]' }, {});
    });

    it('a thrown hook error aborts the run and rejects execute(), without being swallowed', async () => {
      const { HookRegistry } = await import('./hooks');
      const hooks = new HookRegistry();
      hooks.register({
        name: 'rate-limit',
        preGenerate: () => {
          throw new Error('rate limit exceeded');
        },
      });

      const agent = AgentBuilder.create()
        .setType(AgentType.SmartAssistant)
        .setName('Test Agent')
        .build();

      await expect(
        AgentExecutor.execute({
          agent,
          input: 'Hello',
          provider,
          hooks,
        })
      ).rejects.toThrow('rate limit exceeded');
    });

    it('does not run any hooks when none are provided (backward compatible default)', async () => {
      const agent = AgentBuilder.create()
        .setType(AgentType.SmartAssistant)
        .setName('Test Agent')
        .build();

      const result = await AgentExecutor.execute({
        agent,
        input: 'Hello',
        provider,
      });

      expect(result.finishReason).toBeDefined();
    });
  });
});
