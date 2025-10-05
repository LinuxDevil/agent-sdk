/**
 * Context Builder Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ContextBuilder } from './ContextBuilder';
import { MemoryManager } from './MemoryManager';
import { MockMemoryRepository } from '../data/mocks';
import { AgentConfig } from '../types';
import { Message } from '../providers';

describe('ContextBuilder', () => {
  let testAgent: AgentConfig;
  let memoryManager: MemoryManager;

  beforeEach(() => {
    testAgent = {
      id: 'agent-1',
      name: 'Test Agent',
      agentType: 'smart-assistant' as any,
      metadata: {
        description: 'A helpful assistant',
      },
      prompt: 'You are a helpful AI assistant.',
      tools: {},
    };

    const repository = new MockMemoryRepository();
    memoryManager = new MemoryManager({ repository });
  });

  describe('Build', () => {
    it('should build basic context from string input', async () => {
      const context = await ContextBuilder.build({
        agent: testAgent,
        input: 'Hello!',
      });

      expect(context.messages.length).toBeGreaterThan(0);
      expect(context.messages.some((m) => m.content === 'Hello!')).toBe(true);
      expect(context.systemPrompt).toContain('Test Agent');
      expect(context.metadata.agentId).toBe('agent-1');
    });

    it('should build context from message array input', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello!' },
        { role: 'assistant', content: 'Hi there!' },
      ];

      const context = await ContextBuilder.build({
        agent: testAgent,
        input: messages,
      });

      expect(context.messages.length).toBeGreaterThanOrEqual(messages.length);
      expect(context.messages.some((m) => m.content === 'Hello!')).toBe(true);
      expect(context.messages.some((m) => m.content === 'Hi there!')).toBe(
        true
      );
    });

    it('should include session history', async () => {
      const sessionHistory: Message[] = [
        { role: 'user', content: 'Previous message 1' },
        { role: 'assistant', content: 'Response 1' },
        { role: 'user', content: 'Previous message 2' },
        { role: 'assistant', content: 'Response 2' },
      ];

      const context = await ContextBuilder.build({
        agent: testAgent,
        input: 'New message',
        sessionHistory,
      });

      expect(context.messages.some((m) => m.content === 'Previous message 1')).toBe(true);
      expect(context.messages.some((m) => m.content === 'Response 2')).toBe(true);
      expect(context.metadata.historyCount).toBe(4);
    });

    it('should limit session history', async () => {
      const sessionHistory: Message[] = Array.from({ length: 30 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}`,
      })) as Message[];

      const context = await ContextBuilder.build({
        agent: testAgent,
        input: 'New message',
        sessionHistory,
        maxHistoryMessages: 5,
      });

      // Should only include last 5 history messages + system + new input
      const historyMessages = context.messages.filter(
        (m) => m.role !== 'system' && m.content !== 'New message'
      );
      expect(historyMessages.length).toBeLessThanOrEqual(5);
    });

    it('should include memories in system prompt', async () => {
      // Store some memories
      await memoryManager.store({
        agentId: 'agent-1',
        content: 'User prefers dark mode',
      });

      await memoryManager.store({
        agentId: 'agent-1',
        content: 'User likes pizza',
      });

      const context = await ContextBuilder.build({
        agent: testAgent,
        input: 'Hello!',
        memoryManager,
        maxMemories: 5,
      });

      expect(context.systemPrompt).toContain('Relevant Memories');
      expect(context.systemPrompt).toContain('dark mode');
    });

    it('should inject variables', async () => {
      const context = await ContextBuilder.build({
        agent: testAgent,
        input: 'Hello {{userName}}, you are from {{city}}!',
        variables: {
          userName: 'Alice',
          city: 'New York',
        },
      });

      const userMessage = context.messages.find((m) => m.role === 'user');
      expect(userMessage?.content).toBe('Hello Alice, you are from New York!');
    });

    it('should use custom system prompt', async () => {
      const customPrompt = 'Custom system instructions';

      const context = await ContextBuilder.build({
        agent: testAgent,
        input: 'Hello!',
        systemPrompt: customPrompt,
      });

      expect(context.systemPrompt).toContain('Test Agent');
      expect(context.systemPrompt).toContain(customPrompt);
    });

    it('should set correct metadata', async () => {
      const context = await ContextBuilder.build({
        agent: testAgent,
        input: 'Hello!',
        memoryManager,
      });

      expect(context.metadata).toEqual({
        agentId: 'agent-1',
        agentName: 'Test Agent',
        agentType: 'smart-assistant',
        hasMemories: true,
        memoryCount: 0,
        historyCount: 0,
      });
    });
  });

  describe('System Prompt Building', () => {
    it('should include agent name', async () => {
      const context = await ContextBuilder.build({
        agent: testAgent,
        input: 'Hello!',
      });

      expect(context.systemPrompt).toContain('You are Test Agent');
    });

    it('should include agent description', async () => {
      const context = await ContextBuilder.build({
        agent: testAgent,
        input: 'Hello!',
      });

      expect(context.systemPrompt).toContain('A helpful assistant');
    });

    it('should include agent system prompt', async () => {
      const context = await ContextBuilder.build({
        agent: testAgent,
        input: 'Hello!',
      });

      expect(context.systemPrompt).toContain(
        'You are a helpful AI assistant.'
      );
    });

    it('should handle agent without system prompt', async () => {
      const agentNoPrompt = { ...testAgent, systemPrompt: '' };

      const context = await ContextBuilder.build({
        agent: agentNoPrompt,
        input: 'Hello!',
      });

      expect(context.systemPrompt).toBeDefined();
      expect(context.systemPrompt).toContain('Test Agent');
    });
  });

  describe('Variable Injection', () => {
    it('should replace single variable', async () => {
      const context = await ContextBuilder.build({
        agent: testAgent,
        input: 'Hello {{name}}!',
        variables: { name: 'Alice' },
      });

      const userMessage = context.messages.find((m) => m.role === 'user');
      expect(userMessage?.content).toBe('Hello Alice!');
    });

    it('should replace multiple variables', async () => {
      const context = await ContextBuilder.build({
        agent: testAgent,
        input: '{{greeting}} {{name}}, you are {{age}} years old',
        variables: {
          greeting: 'Hello',
          name: 'Bob',
          age: 25,
        },
      });

      const userMessage = context.messages.find((m) => m.role === 'user');
      expect(userMessage?.content).toBe('Hello Bob, you are 25 years old');
    });

    it('should keep unchanged if variable not found', async () => {
      const context = await ContextBuilder.build({
        agent: testAgent,
        input: 'Hello {{name}}!',
        variables: {},
      });

      const userMessage = context.messages.find((m) => m.role === 'user');
      expect(userMessage?.content).toBe('Hello {{name}}!');
    });

    it('should handle variables in system prompt', async () => {
      const agentWithVars: AgentConfig = {
        ...testAgent,
        prompt: 'You are {{agentRole}}',
      };

      const context = await ContextBuilder.build({
        agent: agentWithVars,
        input: 'Hello!',
        variables: { agentRole: 'a coding assistant' },
      });

      expect(context.systemPrompt).toContain('You are a coding assistant');
    });
  });

  describe('Merge', () => {
    it('should merge two contexts', async () => {
      const context1 = await ContextBuilder.build({
        agent: testAgent,
        input: 'Message 1',
        variables: { var1: 'value1' },
      });

      const context2 = await ContextBuilder.build({
        agent: testAgent,
        input: 'Message 2',
        variables: { var2: 'value2' },
      });

      const merged = ContextBuilder.merge(context1, context2);

      expect(merged.messages.length).toBeGreaterThan(context1.messages.length);
      expect(merged.variables).toEqual({
        var1: 'value1',
        var2: 'value2',
      });
    });

    it('should deduplicate system messages', async () => {
      const context1 = await ContextBuilder.build({
        agent: testAgent,
        input: 'Message 1',
      });

      const context2 = await ContextBuilder.build({
        agent: testAgent,
        input: 'Message 2',
      });

      const merged = ContextBuilder.merge(context1, context2);

      const systemMessages = merged.messages.filter(
        (m) => m.role === 'system'
      );
      const uniqueSystemMessages = new Set(systemMessages.map((m) => m.content));

      expect(uniqueSystemMessages.size).toBe(systemMessages.length);
    });

    it('should override variables in later contexts', async () => {
      const context1 = await ContextBuilder.build({
        agent: testAgent,
        input: 'Message 1',
        variables: { name: 'Alice', age: 25 },
      });

      const context2 = await ContextBuilder.build({
        agent: testAgent,
        input: 'Message 2',
        variables: { name: 'Bob' },
      });

      const merged = ContextBuilder.merge(context1, context2);

      expect(merged.variables).toEqual({
        name: 'Bob', // Overridden
        age: 25, // Kept
      });
    });

    it('should throw if no contexts provided', () => {
      expect(() => ContextBuilder.merge()).toThrow(
        'At least one context is required'
      );
    });

    it('should return same context if only one provided', async () => {
      const context = await ContextBuilder.build({
        agent: testAgent,
        input: 'Message',
      });

      const merged = ContextBuilder.merge(context);

      expect(merged).toBe(context);
    });
  });

  describe('Clone', () => {
    it('should clone context without modifications', async () => {
      const original = await ContextBuilder.build({
        agent: testAgent,
        input: 'Hello!',
        variables: { name: 'Alice' },
      });

      const cloned = ContextBuilder.clone(original);

      expect(cloned).not.toBe(original);
      expect(cloned.messages).toEqual(original.messages);
      expect(cloned.variables).toEqual(original.variables);
      expect(cloned.systemPrompt).toBe(original.systemPrompt);
    });

    it('should clone with modifications', async () => {
      const original = await ContextBuilder.build({
        agent: testAgent,
        input: 'Hello!',
        variables: { name: 'Alice' },
      });

      const cloned = ContextBuilder.clone(original, {
        variables: { name: 'Bob' },
      });

      expect(cloned.variables.name).toBe('Bob');
      expect(original.variables.name).toBe('Alice');
    });

    it('should not mutate original context', async () => {
      const original = await ContextBuilder.build({
        agent: testAgent,
        input: 'Hello!',
        variables: { name: 'Alice' },
      });

      const cloned = ContextBuilder.clone(original);
      cloned.variables.name = 'Bob';

      expect(original.variables.name).toBe('Alice');
    });
  });

  describe('Extract Variables', () => {
    it('should extract variables from messages', async () => {
      const context = await ContextBuilder.build({
        agent: testAgent,
        input: 'Hello {{name}}, you are from {{city}}!',
      });

      const variables = ContextBuilder.extractVariables(context);

      expect(variables).toContain('name');
      expect(variables).toContain('city');
    });

    it('should return empty array if no variables', async () => {
      const context = await ContextBuilder.build({
        agent: testAgent,
        input: 'Hello!',
      });

      const variables = ContextBuilder.extractVariables(context);

      expect(variables).toEqual([]);
    });

    it('should not duplicate variables', async () => {
      const context = await ContextBuilder.build({
        agent: testAgent,
        input: 'Hello {{name}}, goodbye {{name}}!',
      });

      const variables = ContextBuilder.extractVariables(context);

      expect(variables).toEqual(['name']);
    });
  });

  describe('Validate', () => {
    it('should validate context with all variables present', async () => {
      const context = await ContextBuilder.build({
        agent: testAgent,
        input: 'Hello {{name}}!',
        variables: { name: 'Alice' },
      });

      const result = ContextBuilder.validate(context);

      expect(result.valid).toBe(true);
      expect(result.missingVariables).toEqual([]);
    });

    it('should detect missing variables', async () => {
      const context = await ContextBuilder.build({
        agent: testAgent,
        input: 'Hello {{name}}, you are from {{city}}!',
        variables: { name: 'Alice' },
      });

      const result = ContextBuilder.validate(context);

      expect(result.valid).toBe(false);
      expect(result.missingVariables).toEqual(['city']);
    });

    it('should validate context with no variables needed', async () => {
      const context = await ContextBuilder.build({
        agent: testAgent,
        input: 'Hello!',
      });

      const result = ContextBuilder.validate(context);

      expect(result.valid).toBe(true);
      expect(result.missingVariables).toEqual([]);
    });
  });
});
