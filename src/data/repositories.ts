/**
 * Repository Interfaces
 * Define the contract for data access operations
 * Implementation-agnostic (can use Drizzle, Prisma, MongoDB, etc.)
 */

import { Agent, Session, Result, Memory, Attachment } from './models';
import { AgentConfig } from '../types';

/**
 * Base Repository Interface
 * Provides common CRUD operations
 */
export interface BaseRepository<T, TId = string> {
  findById(id: TId): Promise<T | null>;
  findMany(filter?: Partial<T>): Promise<T[]>;
  create(data: Omit<T, 'id' | 'createdAt' | 'updatedAt'>): Promise<T>;
  update(id: TId, data: Partial<T>): Promise<T>;
  delete(id: TId): Promise<boolean>;
  count(filter?: Partial<T>): Promise<number>;
}

/**
 * Pagination Options
 */
export interface PaginationOptions {
  page?: number;
  perPage?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

/**
 * Paginated Result
 */
export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
  hasMore: boolean;
}

/**
 * Agent Repository Interface
 */
export interface AgentRepository extends BaseRepository<Agent> {
  findByType(type: string): Promise<Agent[]>;
  findByName(name: string): Promise<Agent | null>;
  search(query: string): Promise<Agent[]>;
  findWithPagination(options: PaginationOptions): Promise<PaginatedResult<Agent>>;
}

/**
 * Session Repository Interface
 */
export interface SessionRepository extends BaseRepository<Session> {
  findByAgentId(agentId: string): Promise<Session[]>;
  findWithMessages(sessionId: string): Promise<Session | null>;
  addMessage(sessionId: string, message: any): Promise<Session>;
  updateData(sessionId: string, data: Record<string, any>): Promise<Session>;
}

/**
 * Result Repository Interface
 */
export interface ResultRepository extends BaseRepository<Result> {
  findBySessionId(sessionId: string): Promise<Result | null>;
  findByAgentId(agentId: string): Promise<Result[]>;
  findSuccessful(): Promise<Result[]>;
  findFailed(): Promise<Result[]>;
}

/**
 * Memory Repository Interface
 */
export interface MemoryRepository extends BaseRepository<Memory> {
  findByAgentId(agentId: string, limit?: number): Promise<Memory[]>;
  findBySessionId(sessionId: string): Promise<Memory[]>;
  search(agentId: string, query: string, limit?: number): Promise<Memory[]>;
  searchByEmbedding(agentId: string, embedding: number[], limit?: number): Promise<Memory[]>;
}

/**
 * Attachment Repository Interface
 */
export interface AttachmentRepository extends BaseRepository<Attachment, number> {
  findByStorageKey(storageKey: string): Promise<Attachment | null>;
  findByType(type: string): Promise<Attachment[]>;
  findWithContent(id: number): Promise<Attachment | null>;
}

/**
 * Repository Collection
 * Container for all repository instances
 */
export interface RepositoryCollection {
  agents: AgentRepository;
  sessions: SessionRepository;
  results: ResultRepository;
  memories?: MemoryRepository;
  attachments?: AttachmentRepository;
}

/**
 * Repository Factory Interface
 * Creates repository instances with specific configuration
 */
export interface RepositoryFactory {
  createAgentRepository(): AgentRepository;
  createSessionRepository(): SessionRepository;
  createResultRepository(): ResultRepository;
  createMemoryRepository(): MemoryRepository;
  createAttachmentRepository(): AttachmentRepository;
  createAll(): RepositoryCollection;
}
