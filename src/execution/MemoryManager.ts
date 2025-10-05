/**
 * Memory Manager
 * Manages agent memories with relevance-based recall
 */

import { Memory, MemoryRepository } from '../data';
import { nanoid } from 'nanoid';

/**
 * Memory manager configuration
 */
export interface MemoryManagerConfig {
  repository: MemoryRepository;
  maxMemories?: number;
  relevanceThreshold?: number;
}

/**
 * Store memory options
 */
export interface StoreMemoryOptions {
  agentId: string;
  content: string;
  metadata?: Record<string, any>;
  embedding?: number[];
  importance?: number;
}

/**
 * Recall memory options
 */
export interface RecallMemoryOptions {
  agentId: string;
  query?: string;
  embedding?: number[];
  limit?: number;
  minRelevance?: number;
}

/**
 * Memory search result
 */
export interface MemorySearchResult {
  memory: Memory;
  relevance: number;
}

/**
 * Memory Manager
 * 
 * Manages agent memories with relevance-based recall and vector similarity search.
 * 
 * @example
 * ```typescript
 * const manager = new MemoryManager({
 *   repository: mockRepository,
 *   maxMemories: 100,
 * });
 * 
 * // Store a memory
 * await manager.store({
 *   agentId: 'agent-1',
 *   content: 'User prefers dark mode',
 *   metadata: { category: 'preference' },
 * });
 * 
 * // Recall relevant memories
 * const memories = await manager.recall({
 *   agentId: 'agent-1',
 *   query: 'user preferences',
 *   limit: 5,
 * });
 * ```
 */
export class MemoryManager {
  private config: Required<MemoryManagerConfig>;

  constructor(config: MemoryManagerConfig) {
    this.config = {
      repository: config.repository,
      maxMemories: config.maxMemories ?? 1000,
      relevanceThreshold: config.relevanceThreshold ?? 0.5,
    };
  }

  /**
   * Store a new memory
   */
  async store(options: StoreMemoryOptions): Promise<Memory> {
    const { agentId, content, metadata, embedding, importance = 1 } = options;

    // Check if we need to prune old memories
    await this.pruneMemoriesIfNeeded(agentId);

    // Create memory with extended metadata
    const extendedMetadata = {
      ...metadata,
      importance,
      accessCount: 0,
      accessedAt: new Date().toISOString(),
    };

    const memory = new Memory({
      id: nanoid(),
      agentId,
      content,
      embedding: embedding ?? [],
      metadata: extendedMetadata,
      createdAt: new Date().toISOString(),
    });

    // Store in repository
    return await this.config.repository.create(memory);
  }

  /**
   * Recall relevant memories
   */
  async recall(options: RecallMemoryOptions): Promise<MemorySearchResult[]> {
    const {
      agentId,
      query,
      embedding,
      limit = 10,
      minRelevance = this.config.relevanceThreshold,
    } = options;

    let memories: Memory[];

    // Use embedding search if available
    if (embedding && embedding.length > 0) {
      memories = await this.config.repository.searchByEmbedding(
        agentId,
        embedding,
        limit * 2 // Get more to filter by relevance
      );
    } else {
      // Fallback to getting recent memories
      memories = await this.config.repository.findByAgentId(agentId, limit * 2);
    }

    // Calculate relevance scores
    const results = memories.map((memory) => ({
      memory,
      relevance: this.calculateRelevance(memory, { query, embedding }),
    }));

    // Filter by minimum relevance and sort
    const filtered = results
      .filter((r) => r.relevance >= minRelevance)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, limit);

    // Update access stats
    await Promise.all(
      filtered.map((r) =>
        this.updateAccessStats(r.memory.id!)
      )
    );

    return filtered;
  }

  /**
   * Search memories by embedding (vector similarity)
   */
  async searchByEmbedding(
    agentId: string,
    embedding: number[],
    limit: number = 10
  ): Promise<MemorySearchResult[]> {
    const memories = await this.config.repository.searchByEmbedding(
      agentId,
      embedding,
      limit
    );

    return memories.map((memory) => ({
      memory,
      relevance: this.calculateEmbeddingSimilarity(embedding, memory.embedding || []),
    }));
  }

  /**
   * Get memory by ID
   */
  async getById(id: string): Promise<Memory | null> {
    return await this.config.repository.findById(id);
  }

  /**
   * Update memory
   */
  async update(id: string, updates: Partial<Memory>): Promise<Memory> {
    return await this.config.repository.update(id, updates);
  }

  /**
   * Delete memory
   */
  async delete(id: string): Promise<void> {
    await this.config.repository.delete(id);
  }

  /**
   * Delete all memories for an agent
   */
  async deleteAllForAgent(agentId: string): Promise<void> {
    const memories = await this.config.repository.findByAgentId(agentId, 1000);
    
    await Promise.all(
      memories.map((memory) => this.config.repository.delete(memory.id!))
    );
  }

  /**
   * Get memory statistics for an agent
   */
  async getStats(agentId: string): Promise<{
    total: number;
    avgImportance: number;
    avgAccessCount: number;
    oldestMemory: string | null;
    newestMemory: string | null;
  }> {
    const memories = await this.config.repository.findByAgentId(agentId, 1000);

    if (memories.length === 0) {
      return {
        total: 0,
        avgImportance: 0,
        avgAccessCount: 0,
        oldestMemory: null,
        newestMemory: null,
      };
    }

    // Extract metadata
    const importances = memories.map((m) => m.metadata?.importance || 1);
    const accessCounts = memories.map((m) => m.metadata?.accessCount || 0);
    
    const avgImportance =
      importances.reduce((sum: number, val: number) => sum + val, 0) / memories.length;
    const avgAccessCount =
      accessCounts.reduce((sum: number, val: number) => sum + val, 0) / memories.length;
    const sortedByDate = [...memories].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    return {
      total: memories.length,
      avgImportance,
      avgAccessCount,
      oldestMemory: sortedByDate[0].createdAt,
      newestMemory: sortedByDate[sortedByDate.length - 1].createdAt,
    };
  }

  /**
   * Calculate relevance score for a memory
   */
  private calculateRelevance(
    memory: Memory,
    context: { query?: string; embedding?: number[] }
  ): number {
    let score = 0;

    const importance = memory.metadata?.importance || 1;
    const accessCount = memory.metadata?.accessCount || 0;

    // Base score from importance
    score += importance * 0.3;

    // Recency bonus (newer memories are more relevant)
    const createdAt = new Date(memory.createdAt).getTime();
    const ageInDays = (Date.now() - createdAt) / (1000 * 60 * 60 * 24);
    const recencyScore = Math.max(0, 1 - ageInDays / 30); // Decay over 30 days
    score += recencyScore * 0.2;

    // Access frequency bonus
    const accessScore = Math.min(1, accessCount / 10);
    score += accessScore * 0.1;

    // Embedding similarity
    if (context.embedding && memory.embedding && memory.embedding.length > 0) {
      const similarity = this.calculateEmbeddingSimilarity(
        context.embedding,
        memory.embedding
      );
      score += similarity * 0.4;
    }

    // Text similarity (simple keyword matching)
    if (context.query) {
      const textSimilarity = this.calculateTextSimilarity(
        context.query,
        memory.content
      );
      score += textSimilarity * 0.4;
    }

    return Math.min(1, score);
  }

  /**
   * Calculate cosine similarity between two embeddings
   */
  private calculateEmbeddingSimilarity(
    embedding1: number[],
    embedding2: number[]
  ): number {
    if (embedding1.length === 0 || embedding2.length === 0) {
      return 0;
    }

    if (embedding1.length !== embedding2.length) {
      return 0;
    }

    let dotProduct = 0;
    let magnitude1 = 0;
    let magnitude2 = 0;

    for (let i = 0; i < embedding1.length; i++) {
      dotProduct += embedding1[i] * embedding2[i];
      magnitude1 += embedding1[i] * embedding1[i];
      magnitude2 += embedding2[i] * embedding2[i];
    }

    magnitude1 = Math.sqrt(magnitude1);
    magnitude2 = Math.sqrt(magnitude2);

    if (magnitude1 === 0 || magnitude2 === 0) {
      return 0;
    }

    return dotProduct / (magnitude1 * magnitude2);
  }

  /**
   * Calculate text similarity (simple keyword matching)
   */
  private calculateTextSimilarity(query: string, content: string): number {
    const queryWords = query.toLowerCase().split(/\s+/);
    const contentWords = content.toLowerCase().split(/\s+/);
    const contentSet = new Set(contentWords);

    const matchingWords = queryWords.filter((word) => contentSet.has(word));
    
    if (queryWords.length === 0) {
      return 0;
    }

    return matchingWords.length / queryWords.length;
  }

  /**
   * Update access statistics for a memory
   */
  private async updateAccessStats(memoryId: string): Promise<void> {
    const memory = await this.config.repository.findById(memoryId);
    
    if (memory) {
      const currentAccessCount = memory.metadata?.accessCount || 0;
      const updatedMetadata = {
        ...memory.metadata,
        accessedAt: new Date().toISOString(),
        accessCount: currentAccessCount + 1,
      };
      
      await this.config.repository.update(memoryId, {
        metadata: updatedMetadata,
      });
    }
  }

  /**
   * Prune old memories if limit is exceeded
   */
  private async pruneMemoriesIfNeeded(agentId: string): Promise<void> {
    const stats = await this.getStats(agentId);

    if (stats.total >= this.config.maxMemories) {
      // Get all memories for this agent
      const memories = await this.config.repository.findByAgentId(agentId, 1000);

      // Sort by relevance (importance, recency, access count)
      const sorted = [...memories].sort((a, b) => {
        const importanceA = a.metadata?.importance || 1;
        const importanceB = b.metadata?.importance || 1;
        const accessCountA = a.metadata?.accessCount || 0;
        const accessCountB = b.metadata?.accessCount || 0;
        const ageA = Date.now() - new Date(a.createdAt).getTime();
        const ageB = Date.now() - new Date(b.createdAt).getTime();
        
        const scoreA = importanceA * 0.5 + 
                      (accessCountA / 10) * 0.3 + 
                      (1 - ageA / (1000 * 60 * 60 * 24 * 30)) * 0.2;
        const scoreB = importanceB * 0.5 + 
                      (accessCountB / 10) * 0.3 + 
                      (1 - ageB / (1000 * 60 * 60 * 24 * 30)) * 0.2;
        return scoreA - scoreB; // Sort ascending (least relevant first)
      });

      // Delete least relevant memories
      const toDelete = Math.ceil(this.config.maxMemories * 0.1); // Delete 10% of limit
      const memoriesToDelete = sorted.slice(0, toDelete);

      await Promise.all(
        memoriesToDelete.map((memory) =>
          this.config.repository.delete(memory.id!)
        )
      );
    }
  }
}
