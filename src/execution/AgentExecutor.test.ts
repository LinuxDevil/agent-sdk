import { describe, it, expect, beforeEach } from 'vitest';
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
