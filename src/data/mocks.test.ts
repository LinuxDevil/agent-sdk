import { describe, it, expect, beforeEach } from 'vitest';
import {
  MockAgentRepository,
  MockSessionRepository,
  MockResultRepository,
  MockMemoryRepository,
  MockAttachmentRepository,
} from './mocks';
import { Agent, Session, Result, Memory, Attachment } from './models';
import { AgentType } from '../types';

describe('Mock Repositories', () => {
  describe('MockAgentRepository', () => {
    let repo: MockAgentRepository;

    beforeEach(() => {
      repo = new MockAgentRepository();
    });

    it('should create agent', async () => {
      const agent = await repo.create({
        name: 'Test Agent',
        agentType: AgentType.SmartAssistant,
        locale: 'en',
      });

      expect(agent.id).toBeDefined();
      expect(agent.name).toBe('Test Agent');
      expect(agent.createdAt).toBeDefined();
    });

    it('should find agent by id', async () => {
      const created = await repo.create({
        name: 'Test Agent',
        agentType: AgentType.SmartAssistant,
        locale: 'en',
      });

      const found = await repo.findById(created.id!);

      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
    });

    it('should find agents by type', async () => {
      await repo.create({
        name: 'Agent 1',
        agentType: AgentType.SmartAssistant,
        locale: 'en',
      });
      await repo.create({
        name: 'Agent 2',
        agentType: AgentType.SurveyAgent,
        locale: 'en',
      });

      const smartAgents = await repo.findByType(AgentType.SmartAssistant);

      expect(smartAgents).toHaveLength(1);
      expect(smartAgents[0].agentType).toBe(AgentType.SmartAssistant);
    });

    it('should find agent by name', async () => {
      await repo.create({
        name: 'Unique Agent',
        agentType: AgentType.SmartAssistant,
        locale: 'en',
      });

      const found = await repo.findByName('Unique Agent');

      expect(found).toBeDefined();
      expect(found?.name).toBe('Unique Agent');
    });

    it('should search agents', async () => {
      await repo.create({
        name: 'Customer Support',
        agentType: AgentType.SmartAssistant,
        locale: 'en',
        prompt: 'Help customers',
      });
      await repo.create({
        name: 'Sales Agent',
        agentType: AgentType.SmartAssistant,
        locale: 'en',
        prompt: 'Close deals',
      });

      const results = await repo.search('customer');

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Customer Support');
    });

    it('should paginate agents', async () => {
      for (let i = 0; i < 25; i++) {
        await repo.create({
          name: `Agent ${i}`,
          agentType: AgentType.SmartAssistant,
          locale: 'en',
        });
      }

      const page1 = await repo.findWithPagination({ page: 1, perPage: 10 });
      const page2 = await repo.findWithPagination({ page: 2, perPage: 10 });

      expect(page1.data).toHaveLength(10);
      expect(page1.total).toBe(25);
      expect(page1.totalPages).toBe(3);
      expect(page1.hasMore).toBe(true);

      expect(page2.data).toHaveLength(10);
      expect(page2.page).toBe(2);
    });

    it('should update agent', async () => {
      const agent = await repo.create({
        name: 'Original Name',
        agentType: AgentType.SmartAssistant,
        locale: 'en',
      });

      // Small delay to ensure timestamp difference
      await new Promise(resolve => setTimeout(resolve, 10));

      const updated = await repo.update(agent.id!, {
        name: 'Updated Name',
      });

      expect(updated.name).toBe('Updated Name');
      expect(new Date(updated.updatedAt!).getTime()).toBeGreaterThan(
        new Date(agent.updatedAt!).getTime()
      );
    });

    it('should delete agent', async () => {
      const agent = await repo.create({
        name: 'To Delete',
        agentType: AgentType.SmartAssistant,
        locale: 'en',
      });

      const deleted = await repo.delete(agent.id!);

      expect(deleted).toBe(true);

      const found = await repo.findById(agent.id!);
      expect(found).toBeNull();
    });

    it('should count agents', async () => {
      await repo.create({
        name: 'Agent 1',
        agentType: AgentType.SmartAssistant,
        locale: 'en',
      });
      await repo.create({
        name: 'Agent 2',
        agentType: AgentType.SmartAssistant,
        locale: 'en',
      });

      const count = await repo.count();

      expect(count).toBe(2);
    });
  });

  describe('MockSessionRepository', () => {
    let repo: MockSessionRepository;

    beforeEach(() => {
      repo = new MockSessionRepository();
    });

    it('should create session', async () => {
      const session = await repo.create({
        agentId: 'agent-1',
        data: {},
        messages: [],
      });

      expect(session.id).toBeDefined();
      expect(session.agentId).toBe('agent-1');
    });

    it('should find sessions by agent id', async () => {
      await repo.create({ agentId: 'agent-1', data: {}, messages: [] });
      await repo.create({ agentId: 'agent-1', data: {}, messages: [] });
      await repo.create({ agentId: 'agent-2', data: {}, messages: [] });

      const sessions = await repo.findByAgentId('agent-1');

      expect(sessions).toHaveLength(2);
    });

    it('should add message to session', async () => {
      const session = await repo.create({
        agentId: 'agent-1',
        data: {},
        messages: [],
      });

      const updated = await repo.addMessage(session.id, {
        role: 'user',
        content: 'Hello',
      });

      expect(updated.messages).toHaveLength(1);
      expect(updated.messages![0].content).toBe('Hello');
    });

    it('should update session data', async () => {
      const session = await repo.create({
        agentId: 'agent-1',
        data: { key1: 'value1' },
        messages: [],
      });

      const updated = await repo.updateData(session.id, { key2: 'value2' });

      expect(updated.data).toEqual({ key1: 'value1', key2: 'value2' });
    });
  });

  describe('MockResultRepository', () => {
    let repo: MockResultRepository;

    beforeEach(() => {
      repo = new MockResultRepository();
    });

    it('should create result', async () => {
      const result = await repo.create({
        sessionId: 'session-1',
        agentId: 'agent-1',
        result: { answer: '42' },
        success: true,
      });

      expect(result.id).toBeDefined();
      expect(result.success).toBe(true);
    });

    it('should find result by session id', async () => {
      await repo.create({
        sessionId: 'session-1',
        agentId: 'agent-1',
        result: {},
        success: true,
      });

      const found = await repo.findBySessionId('session-1');

      expect(found).toBeDefined();
      expect(found?.sessionId).toBe('session-1');
    });

    it('should find results by agent id', async () => {
      await repo.create({
        sessionId: 's1',
        agentId: 'agent-1',
        result: {},
        success: true,
      });
      await repo.create({
        sessionId: 's2',
        agentId: 'agent-1',
        result: {},
        success: true,
      });

      const results = await repo.findByAgentId('agent-1');

      expect(results).toHaveLength(2);
    });

    it('should find successful results', async () => {
      await repo.create({
        sessionId: 's1',
        agentId: 'a1',
        result: {},
        success: true,
      });
      await repo.create({
        sessionId: 's2',
        agentId: 'a1',
        result: {},
        success: false,
      });

      const successful = await repo.findSuccessful();

      expect(successful).toHaveLength(1);
      expect(successful[0].success).toBe(true);
    });

    it('should find failed results', async () => {
      await repo.create({
        sessionId: 's1',
        agentId: 'a1',
        result: {},
        success: true,
      });
      await repo.create({
        sessionId: 's2',
        agentId: 'a1',
        result: {},
        success: false,
      });

      const failed = await repo.findFailed();

      expect(failed).toHaveLength(1);
      expect(failed[0].success).toBe(false);
    });
  });

  describe('MockMemoryRepository', () => {
    let repo: MockMemoryRepository;

    beforeEach(() => {
      repo = new MockMemoryRepository();
    });

    it('should create memory', async () => {
      const memory = await repo.create({
        agentId: 'agent-1',
        content: 'Important fact',
      });

      expect(memory.id).toBeDefined();
      expect(memory.content).toBe('Important fact');
    });

    it('should find memories by agent id', async () => {
      await repo.create({ agentId: 'agent-1', content: 'Fact 1' });
      await repo.create({ agentId: 'agent-1', content: 'Fact 2' });
      await repo.create({ agentId: 'agent-2', content: 'Fact 3' });

      const memories = await repo.findByAgentId('agent-1');

      expect(memories).toHaveLength(2);
    });

    it('should limit memories by agent id', async () => {
      await repo.create({ agentId: 'agent-1', content: 'Fact 1' });
      await repo.create({ agentId: 'agent-1', content: 'Fact 2' });
      await repo.create({ agentId: 'agent-1', content: 'Fact 3' });

      const memories = await repo.findByAgentId('agent-1', 2);

      expect(memories).toHaveLength(2);
    });

    it('should search memories', async () => {
      await repo.create({
        agentId: 'agent-1',
        content: 'The quick brown fox',
      });
      await repo.create({ agentId: 'agent-1', content: 'Jumps over lazy dog' });

      const results = await repo.search('agent-1', 'quick');

      expect(results).toHaveLength(1);
      expect(results[0].content).toContain('quick');
    });

    it('should search by embedding', async () => {
      await repo.create({
        agentId: 'agent-1',
        content: 'Content 1',
        embedding: [0.1, 0.2, 0.3],
      });
      await repo.create({
        agentId: 'agent-1',
        content: 'Content 2',
        embedding: [0.9, 0.8, 0.7],
      });

      const results = await repo.searchByEmbedding(
        'agent-1',
        [0.1, 0.2, 0.3],
        1
      );

      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('Content 1');
    });
  });

  describe('MockAttachmentRepository', () => {
    let repo: MockAttachmentRepository;

    beforeEach(() => {
      repo = new MockAttachmentRepository();
    });

    it('should create attachment', async () => {
      const attachment = await repo.create({
        displayName: 'file.txt',
        size: 100,
        storageKey: 'files/file.txt',
      });

      expect(attachment.id).toBeDefined();
      expect(attachment.displayName).toBe('file.txt');
    });

    it('should find by storage key', async () => {
      await repo.create({
        displayName: 'file.txt',
        size: 100,
        storageKey: 'unique-key',
      });

      const found = await repo.findByStorageKey('unique-key');

      expect(found).toBeDefined();
      expect(found?.storageKey).toBe('unique-key');
    });

    it('should find by type', async () => {
      await repo.create({
        displayName: 'doc.pdf',
        type: 'document',
        size: 100,
        storageKey: 'key1',
      });
      await repo.create({
        displayName: 'img.png',
        type: 'image',
        size: 200,
        storageKey: 'key2',
      });

      const documents = await repo.findByType('document');

      expect(documents).toHaveLength(1);
      expect(documents[0].type).toBe('document');
    });
  });
});
