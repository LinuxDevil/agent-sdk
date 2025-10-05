/**
 * Memory Manager Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryManager } from './MemoryManager';
import { MockMemoryRepository } from '../data/mocks';
import { Memory } from '../data';

describe('MemoryManager', () => {
  let manager: MemoryManager;
  let repository: MockMemoryRepository;

  beforeEach(() => {
    repository = new MockMemoryRepository();
    manager = new MemoryManager({
      repository,
      maxMemories: 10,
      relevanceThreshold: 0.5,
    });
  });

  describe('Constructor', () => {
    it('should create manager with default config', () => {
      const defaultManager = new MemoryManager({ repository });
      expect(defaultManager).toBeDefined();
    });

    it('should create manager with custom config', () => {
      const customManager = new MemoryManager({
        repository,
        maxMemories: 50,
        relevanceThreshold: 0.7,
      });
      expect(customManager).toBeDefined();
    });
  });

  describe('Store', () => {
    it('should store a basic memory', async () => {
      const memory = await manager.store({
        agentId: 'agent-1',
        content: 'User prefers dark mode',
      });

      expect(memory.id).toBeDefined();
      expect(memory.agentId).toBe('agent-1');
      expect(memory.content).toBe('User prefers dark mode');
      expect(memory.importance).toBe(1);
      expect(memory.accessCount).toBe(0);
    });

    it('should store memory with metadata', async () => {
      const memory = await manager.store({
        agentId: 'agent-1',
        content: 'User likes pizza',
        metadata: { category: 'food', priority: 'high' },
      });

      expect(memory.metadata?.category).toBe('food');
      expect(memory.metadata?.priority).toBe('high');
      expect(memory.metadata?.importance).toBe(1);
      expect(memory.metadata?.accessCount).toBe(0);
      expect(memory.metadata?.accessedAt).toBeDefined();
    });

    it('should store memory with embedding', async () => {
      const embedding = [0.1, 0.2, 0.3, 0.4, 0.5];
      const memory = await manager.store({
        agentId: 'agent-1',
        content: 'Test content',
        embedding,
      });

      expect(memory.embedding).toEqual(embedding);
    });

    it('should store memory with custom importance', async () => {
      const memory = await manager.store({
        agentId: 'agent-1',
        content: 'Important fact',
        importance: 5,
      });

      expect(memory.importance).toBe(5);
    });

    it('should prune old memories when limit exceeded', async () => {
      // Store 11 memories (limit is 10)
      for (let i = 0; i < 11; i++) {
        await manager.store({
          agentId: 'agent-1',
          content: `Memory ${i}`,
          importance: i % 2 === 0 ? 1 : 0.5, // Vary importance
        });
      }

      const stats = await manager.getStats('agent-1');
      expect(stats.total).toBeLessThanOrEqual(10);
    });
  });

  describe('Recall', () => {
    beforeEach(async () => {
      // Store test memories
      await manager.store({
        agentId: 'agent-1',
        content: 'User prefers dark mode',
        metadata: { category: 'preference' },
        importance: 1,
      });

      await manager.store({
        agentId: 'agent-1',
        content: 'User likes pizza and pasta',
        metadata: { category: 'food' },
        importance: 0.8,
      });

      await manager.store({
        agentId: 'agent-1',
        content: 'User is from New York',
        metadata: { category: 'location' },
        importance: 0.6,
      });

      await manager.store({
        agentId: 'agent-2',
        content: 'Different agent memory',
        importance: 1,
      });
    });

    it('should recall memories for specific agent', async () => {
      const results = await manager.recall({
        agentId: 'agent-1',
        limit: 10,
        minRelevance: 0,
      });

      expect(results.length).toBe(3);
      expect(results.every((r) => r.memory.agentId === 'agent-1')).toBe(true);
    });

    it('should recall memories with text query', async () => {
      const results = await manager.recall({
        agentId: 'agent-1',
        query: 'pizza',
        limit: 10,
        minRelevance: 0,
      });

      expect(results.length).toBeGreaterThan(0);
      const pizzaMemory = results.find((r) =>
        r.memory.content.includes('pizza')
      );
      expect(pizzaMemory).toBeDefined();
      expect(pizzaMemory!.relevance).toBeGreaterThan(0);
    });

    it('should limit recall results', async () => {
      const results = await manager.recall({
        agentId: 'agent-1',
        limit: 2,
        minRelevance: 0,
      });

      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('should filter by minimum relevance', async () => {
      const results = await manager.recall({
        agentId: 'agent-1',
        query: 'irrelevant query xyz',
        limit: 10,
        minRelevance: 0.8,
      });

      expect(results.every((r) => r.relevance >= 0.8)).toBe(true);
    });

    it('should update access stats on recall', async () => {
      const results = await manager.recall({
        agentId: 'agent-1',
        limit: 1,
        minRelevance: 0,
      });

      const memoryId = results[0].memory.id;
      const memory = await manager.getById(memoryId);

      expect(memory?.accessCount).toBe(1);
      expect(memory?.accessedAt).toBeDefined();
    });

    it('should use embedding search when available', async () => {
      // Store memory with embedding
      const embedding1 = [1, 0, 0, 0, 0];
      await manager.store({
        agentId: 'agent-1',
        content: 'Memory with embedding',
        embedding: embedding1,
      });

      // Search with similar embedding
      const embedding2 = [0.9, 0.1, 0, 0, 0];
      const results = await manager.recall({
        agentId: 'agent-1',
        embedding: embedding2,
        limit: 10,
        minRelevance: 0,
      });

      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('Search by Embedding', () => {
    it('should find similar memories by embedding', async () => {
      const embedding1 = [1, 0, 0, 0, 0];
      const embedding2 = [0, 1, 0, 0, 0];

      await manager.store({
        agentId: 'agent-1',
        content: 'Memory 1',
        embedding: embedding1,
      });

      await manager.store({
        agentId: 'agent-1',
        content: 'Memory 2',
        embedding: embedding2,
      });

      // Search for embedding1
      const results = await manager.searchByEmbedding(
        'agent-1',
        [0.9, 0.1, 0, 0, 0],
        10
      );

      expect(results.length).toBeGreaterThan(0);
      // First result should be more similar to embedding1
      expect(results[0].memory.content).toBe('Memory 1');
    });

    it('should handle empty embeddings', async () => {
      await manager.store({
        agentId: 'agent-1',
        content: 'Memory without embedding',
      });

      const results = await manager.searchByEmbedding('agent-1', [], 10);
      expect(results).toBeDefined();
    });
  });

  describe('CRUD Operations', () => {
    it('should get memory by ID', async () => {
      const stored = await manager.store({
        agentId: 'agent-1',
        content: 'Test memory',
      });

      const retrieved = await manager.getById(stored.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(stored.id);
      expect(retrieved?.content).toBe('Test memory');
    });

    it('should return null for non-existent memory', async () => {
      const memory = await manager.getById('non-existent-id');
      expect(memory).toBeNull();
    });

    it('should update memory', async () => {
      const stored = await manager.store({
        agentId: 'agent-1',
        content: 'Original content',
      });

      const updated = await manager.update(stored.id!, {
        content: 'Updated content',
        metadata: {
          ...stored.metadata,
          importance: 5,
        },
      });

      expect(updated.content).toBe('Updated content');
      expect(updated.importance).toBe(5);
    });

    it('should delete memory', async () => {
      const stored = await manager.store({
        agentId: 'agent-1',
        content: 'To be deleted',
      });

      await manager.delete(stored.id);

      const retrieved = await manager.getById(stored.id);
      expect(retrieved).toBeNull();
    });

    it('should delete all memories for an agent', async () => {
      await manager.store({
        agentId: 'agent-1',
        content: 'Memory 1',
      });

      await manager.store({
        agentId: 'agent-1',
        content: 'Memory 2',
      });

      await manager.store({
        agentId: 'agent-2',
        content: 'Memory for agent 2',
      });

      await manager.deleteAllForAgent('agent-1');

      const stats1 = await manager.getStats('agent-1');
      const stats2 = await manager.getStats('agent-2');

      expect(stats1.total).toBe(0);
      expect(stats2.total).toBe(1);
    });
  });

  describe('Statistics', () => {
    it('should get stats for agent with memories', async () => {
      await manager.store({
        agentId: 'agent-1',
        content: 'Memory 1',
        importance: 1,
      });

      await manager.store({
        agentId: 'agent-1',
        content: 'Memory 2',
        importance: 0.5,
      });

      const stats = await manager.getStats('agent-1');

      expect(stats.total).toBe(2);
      expect(stats.avgImportance).toBe(0.75);
      expect(stats.avgAccessCount).toBe(0);
      expect(stats.oldestMemory).toBeDefined();
      expect(stats.newestMemory).toBeDefined();
    });

    it('should get empty stats for agent without memories', async () => {
      const stats = await manager.getStats('non-existent-agent');

      expect(stats.total).toBe(0);
      expect(stats.avgImportance).toBe(0);
      expect(stats.avgAccessCount).toBe(0);
      expect(stats.oldestMemory).toBeNull();
      expect(stats.newestMemory).toBeNull();
    });

    it('should update stats after recalls', async () => {
      await manager.store({
        agentId: 'agent-1',
        content: 'Memory 1',
      });

      // Recall multiple times
      await manager.recall({ agentId: 'agent-1', limit: 1, minRelevance: 0 });
      await manager.recall({ agentId: 'agent-1', limit: 1, minRelevance: 0 });

      const stats = await manager.getStats('agent-1');
      expect(stats.avgAccessCount).toBeGreaterThan(0);
    });
  });

  describe('Relevance Calculation', () => {
    it('should give higher relevance to important memories', async () => {
      await manager.store({
        agentId: 'agent-1',
        content: 'Important memory',
        importance: 5,
      });

      await manager.store({
        agentId: 'agent-1',
        content: 'Less important memory',
        importance: 1,
      });

      const results = await manager.recall({
        agentId: 'agent-1',
        limit: 10,
        minRelevance: 0,
      });

      // Higher importance should have higher relevance
      const important = results.find((r) =>
        r.memory.content.includes('Important')
      );
      const lessImportant = results.find((r) =>
        r.memory.content.includes('Less important')
      );

      expect(important!.relevance).toBeGreaterThan(lessImportant!.relevance);
    });

    it('should calculate embedding similarity correctly', async () => {
      const embedding1 = [1, 0, 0];
      const embedding2 = [1, 0, 0]; // Identical
      const embedding3 = [0, 1, 0]; // Orthogonal

      await manager.store({
        agentId: 'agent-1',
        content: 'Similar memory',
        embedding: embedding1,
      });

      await manager.store({
        agentId: 'agent-1',
        content: 'Different memory',
        embedding: embedding3,
      });

      const results = await manager.recall({
        agentId: 'agent-1',
        embedding: embedding2, // Search with identical embedding
        limit: 10,
        minRelevance: 0,
      });

      const similar = results.find((r) =>
        r.memory.content.includes('Similar')
      );
      const different = results.find((r) =>
        r.memory.content.includes('Different')
      );

      // Should be more relevant to similar embedding
      expect(similar!.relevance).toBeGreaterThan(different!.relevance);
    });

    it('should calculate text similarity correctly', async () => {
      await manager.store({
        agentId: 'agent-1',
        content: 'The user likes pizza and pasta',
      });

      await manager.store({
        agentId: 'agent-1',
        content: 'The user prefers dark mode',
      });

      const results = await manager.recall({
        agentId: 'agent-1',
        query: 'pizza pasta',
        limit: 10,
        minRelevance: 0,
      });

      const pizzaMemory = results.find((r) =>
        r.memory.content.includes('pizza')
      );
      const modeMemory = results.find((r) => r.memory.content.includes('mode'));

      // Pizza memory should be more relevant to "pizza pasta" query
      expect(pizzaMemory!.relevance).toBeGreaterThan(modeMemory!.relevance);
    });
  });
});
