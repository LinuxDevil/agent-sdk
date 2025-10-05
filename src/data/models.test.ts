import { describe, it, expect } from 'vitest';
import { Agent, Session, Result, Memory, Attachment } from './models';
import { AgentType } from '../types';

describe('Domain Models', () => {
  describe('Agent', () => {
    it('should create agent from config', () => {
      const agent = new Agent({
        id: 'agent-1',
        name: 'Test Agent',
        agentType: AgentType.SmartAssistant,
        locale: 'en',
        prompt: 'You are a test agent',
      });

      expect(agent.id).toBe('agent-1');
      expect(agent.name).toBe('Test Agent');
      expect(agent.agentType).toBe(AgentType.SmartAssistant);
      expect(agent.prompt).toBe('You are a test agent');
    });

    it('should convert to config', () => {
      const agent = new Agent({
        id: 'agent-1',
        name: 'Test Agent',
        agentType: AgentType.SmartAssistant,
        locale: 'en',
      });

      const config = agent.toConfig();

      expect(config.id).toBe('agent-1');
      expect(config.name).toBe('Test Agent');
      expect(config.agentType).toBe(AgentType.SmartAssistant);
    });

    it('should create from config using static method', () => {
      const config = {
        id: 'agent-1',
        name: 'Test Agent',
        agentType: AgentType.SmartAssistant,
        locale: 'en',
      };

      const agent = Agent.fromConfig(config);

      expect(agent).toBeInstanceOf(Agent);
      expect(agent.id).toBe('agent-1');
    });

    it('should handle optional fields', () => {
      const agent = new Agent({
        name: 'Test',
        agentType: AgentType.SmartAssistant,
        locale: 'en',
        tools: { tool1: { tool: 'test' } },
        flows: [],
        metadata: { key: 'value' },
      });

      expect(agent.tools).toBeDefined();
      expect(agent.flows).toBeDefined();
      expect(agent.metadata).toEqual({ key: 'value' });
    });

    it('should set timestamps', () => {
      const now = new Date().toISOString();
      const agent = new Agent({
        name: 'Test',
        agentType: AgentType.SmartAssistant,
        locale: 'en',
        createdAt: now,
        updatedAt: now,
      });

      expect(agent.createdAt).toBe(now);
      expect(agent.updatedAt).toBe(now);
    });
  });

  describe('Session', () => {
    it('should create session', () => {
      const session = new Session({
        id: 'session-1',
        agentId: 'agent-1',
        data: { key: 'value' },
        messages: [],
      });

      expect(session.id).toBe('session-1');
      expect(session.agentId).toBe('agent-1');
      expect(session.data).toEqual({ key: 'value' });
      expect(session.messages).toEqual([]);
    });

    it('should auto-generate timestamps', () => {
      const session = new Session({
        id: 'session-1',
        agentId: 'agent-1',
      });

      expect(session.createdAt).toBeDefined();
      expect(session.updatedAt).toBeDefined();
    });

    it('should handle messages', () => {
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      ];

      const session = new Session({
        id: 'session-1',
        agentId: 'agent-1',
        messages,
      });

      expect(session.messages).toHaveLength(2);
    });
  });

  describe('Result', () => {
    it('should create successful result', () => {
      const result = new Result({
        id: 'result-1',
        sessionId: 'session-1',
        agentId: 'agent-1',
        result: { answer: '42' },
        success: true,
        tokensUsed: 100,
        duration: 1500,
      });

      expect(result.success).toBe(true);
      expect(result.result).toEqual({ answer: '42' });
      expect(result.tokensUsed).toBe(100);
      expect(result.duration).toBe(1500);
    });

    it('should create failed result with error', () => {
      const result = new Result({
        sessionId: 'session-1',
        agentId: 'agent-1',
        result: null,
        success: false,
        error: 'Something went wrong',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Something went wrong');
    });

    it('should auto-generate timestamp', () => {
      const result = new Result({
        sessionId: 'session-1',
        agentId: 'agent-1',
        result: null,
        success: true,
      });

      expect(result.createdAt).toBeDefined();
    });
  });

  describe('Memory', () => {
    it('should create memory', () => {
      const memory = new Memory({
        id: 'memory-1',
        agentId: 'agent-1',
        sessionId: 'session-1',
        content: 'Remember this important fact',
        metadata: { importance: 'high' },
      });

      expect(memory.content).toBe('Remember this important fact');
      expect(memory.metadata).toEqual({ importance: 'high' });
    });

    it('should handle embedding', () => {
      const embedding = [0.1, 0.2, 0.3];
      const memory = new Memory({
        agentId: 'agent-1',
        content: 'Test content',
        embedding,
      });

      expect(memory.embedding).toEqual(embedding);
    });

    it('should work without session', () => {
      const memory = new Memory({
        agentId: 'agent-1',
        content: 'Global memory',
      });

      expect(memory.sessionId).toBeUndefined();
    });
  });

  describe('Attachment', () => {
    it('should create attachment', () => {
      const attachment = new Attachment({
        id: 1,
        displayName: 'document.pdf',
        mimeType: 'application/pdf',
        type: 'document',
        size: 1024,
        storageKey: 'attachments/doc.pdf',
      });

      expect(attachment.displayName).toBe('document.pdf');
      expect(attachment.mimeType).toBe('application/pdf');
      expect(attachment.size).toBe(1024);
    });

    it('should handle optional fields', () => {
      const attachment = new Attachment({
        displayName: 'file.txt',
        size: 512,
        storageKey: 'files/file.txt',
        description: 'A text file',
        content: 'File content',
        metadata: { tag: 'important' },
      });

      expect(attachment.description).toBe('A text file');
      expect(attachment.content).toBe('File content');
      expect(attachment.metadata).toEqual({ tag: 'important' });
    });

    it('should auto-generate timestamps', () => {
      const attachment = new Attachment({
        displayName: 'file.txt',
        size: 100,
        storageKey: 'key',
      });

      expect(attachment.createdAt).toBeDefined();
      expect(attachment.updatedAt).toBeDefined();
    });
  });
});
