/**
 * Mock Repository Implementations
 * In-memory implementations for testing and development
 */

import {
  AgentRepository,
  SessionRepository,
  ResultRepository,
  MemoryRepository,
  AttachmentRepository,
  PaginationOptions,
  PaginatedResult,
} from './repositories';
import { Agent, Session, Result, Memory, Attachment } from './models';
import { nanoid } from 'nanoid';

/**
 * Base Mock Repository
 * Provides in-memory storage for testing
 */
abstract class BaseMockRepository<T extends { id?: any; createdAt?: string; updatedAt?: string }, TId = string> {
  protected items: Map<TId, T> = new Map();

  async findById(id: TId): Promise<T | null> {
    return this.items.get(id) || null;
  }

  async findMany(filter?: Partial<T>): Promise<T[]> {
    const items = Array.from(this.items.values());
    if (!filter) return items;

    return items.filter(item => {
      return Object.entries(filter).every(([key, value]) => {
        return item[key as keyof T] === value;
      });
    });
  }

  async create(data: any): Promise<T> {
    const id = this.generateId();
    const now = new Date().toISOString();
    const item = {
      ...data,
      id,
      createdAt: now,
      updatedAt: now,
    } as T;
    this.items.set(id as TId, item);
    return item;
  }

  async update(id: TId, data: Partial<T>): Promise<T> {
    const existing = this.items.get(id);
    if (!existing) {
      throw new Error(`Item with id ${id} not found`);
    }

    const updated = {
      ...existing,
      ...data,
      updatedAt: new Date().toISOString(),
    } as T;
    this.items.set(id, updated);
    return updated;
  }

  async delete(id: TId): Promise<boolean> {
    return this.items.delete(id);
  }

  async count(filter?: Partial<T>): Promise<number> {
    const items = await this.findMany(filter);
    return items.length;
  }

  protected abstract generateId(): TId;

  clear(): void {
    this.items.clear();
  }
}

/**
 * Mock Agent Repository
 */
export class MockAgentRepository
  extends BaseMockRepository<Agent, string>
  implements AgentRepository
{
  protected generateId(): string {
    return nanoid();
  }

  async findByType(type: string): Promise<Agent[]> {
    return Array.from(this.items.values()).filter(
      agent => agent.agentType === type
    );
  }

  async findByName(name: string): Promise<Agent | null> {
    const items = Array.from(this.items.values());
    return items.find(agent => agent.name === name) || null;
  }

  async search(query: string): Promise<Agent[]> {
    const lowerQuery = query.toLowerCase();
    return Array.from(this.items.values()).filter(agent =>
      agent.name.toLowerCase().includes(lowerQuery) ||
      agent.prompt?.toLowerCase().includes(lowerQuery)
    );
  }

  async findWithPagination(options: PaginationOptions): Promise<PaginatedResult<Agent>> {
    const { page = 1, perPage = 10 } = options;
    const items = Array.from(this.items.values());
    const total = items.length;
    const start = (page - 1) * perPage;
    const end = start + perPage;
    const data = items.slice(start, end);

    return {
      data,
      total,
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
      hasMore: end < total,
    };
  }
}

/**
 * Mock Session Repository
 */
export class MockSessionRepository
  extends BaseMockRepository<Session, string>
  implements SessionRepository
{
  protected generateId(): string {
    return nanoid();
  }

  async findByAgentId(agentId: string): Promise<Session[]> {
    return Array.from(this.items.values()).filter(
      session => session.agentId === agentId
    );
  }

  async findWithMessages(sessionId: string): Promise<Session | null> {
    return this.findById(sessionId);
  }

  async addMessage(sessionId: string, message: any): Promise<Session> {
    const session = await this.findById(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const messages = session.messages || [];
    return this.update(sessionId, {
      messages: [...messages, message],
    });
  }

  async updateData(sessionId: string, data: Record<string, any>): Promise<Session> {
    const session = await this.findById(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    return this.update(sessionId, {
      data: { ...session.data, ...data },
    });
  }
}

/**
 * Mock Result Repository
 */
export class MockResultRepository
  extends BaseMockRepository<Result, string>
  implements ResultRepository
{
  protected generateId(): string {
    return nanoid();
  }

  async findBySessionId(sessionId: string): Promise<Result | null> {
    const items = Array.from(this.items.values());
    return items.find(result => result.sessionId === sessionId) || null;
  }

  async findByAgentId(agentId: string): Promise<Result[]> {
    return Array.from(this.items.values()).filter(
      result => result.agentId === agentId
    );
  }

  async findSuccessful(): Promise<Result[]> {
    return Array.from(this.items.values()).filter(result => result.success);
  }

  async findFailed(): Promise<Result[]> {
    return Array.from(this.items.values()).filter(result => !result.success);
  }
}

/**
 * Mock Memory Repository
 */
export class MockMemoryRepository
  extends BaseMockRepository<Memory, string>
  implements MemoryRepository
{
  protected generateId(): string {
    return nanoid();
  }

  /**
   * Override create to return Memory class instances
   */
  async create(data: any): Promise<Memory> {
    const id = this.generateId();
    const now = new Date().toISOString();
    const memory = new Memory({
      ...data,
      id,
      createdAt: data.createdAt || now,
    });
    this.items.set(id, memory);
    return memory;
  }

  /**
   * Override update to maintain Memory class instances
   */
  async update(id: string, data: Partial<Memory>): Promise<Memory> {
    const existing = this.items.get(id);
    if (!existing) {
      throw new Error(`Memory with id ${id} not found`);
    }

    const updated = new Memory({
      ...existing,
      ...data,
      id: existing.id,
      agentId: data.agentId || existing.agentId,
      content: data.content || existing.content,
      createdAt: existing.createdAt,
    });
    
    this.items.set(id, updated);
    return updated;
  }

  async findByAgentId(agentId: string, limit?: number): Promise<Memory[]> {
    const memories = Array.from(this.items.values()).filter(
      memory => memory.agentId === agentId
    );
    return limit ? memories.slice(0, limit) : memories;
  }

  async findBySessionId(sessionId: string): Promise<Memory[]> {
    return Array.from(this.items.values()).filter(
      memory => memory.sessionId === sessionId
    );
  }

  async search(agentId: string, query: string, limit = 10): Promise<Memory[]> {
    const lowerQuery = query.toLowerCase();
    const memories = Array.from(this.items.values()).filter(
      memory =>
        memory.agentId === agentId &&
        memory.content.toLowerCase().includes(lowerQuery)
    );
    return memories.slice(0, limit);
  }

  async searchByEmbedding(
    agentId: string,
    embedding: number[],
    limit = 10
  ): Promise<Memory[]> {
    // Simple cosine similarity search
    const memories = Array.from(this.items.values())
      .filter(memory => memory.agentId === agentId && memory.embedding)
      .map(memory => ({
        memory,
        similarity: this.cosineSimilarity(embedding, memory.embedding!),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit)
      .map(item => item.memory);

    return memories;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0);
    const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
    const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
    return dotProduct / (magA * magB);
  }
}

/**
 * Mock Attachment Repository
 */
export class MockAttachmentRepository
  extends BaseMockRepository<Attachment, number>
  implements AttachmentRepository
{
  private nextId = 1;

  protected generateId(): number {
    return this.nextId++;
  }

  async findByStorageKey(storageKey: string): Promise<Attachment | null> {
    const items = Array.from(this.items.values());
    return items.find(att => att.storageKey === storageKey) || null;
  }

  async findByType(type: string): Promise<Attachment[]> {
    return Array.from(this.items.values()).filter(att => att.type === type);
  }

  async findWithContent(id: number): Promise<Attachment | null> {
    return this.findById(id);
  }
}
