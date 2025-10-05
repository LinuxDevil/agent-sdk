import { k as AgentFlow, b as AgentConfig } from '../agent-DL745E0K.js';
import 'ai';
import '../tool-DW-oM1Ru.js';

/**
 * Domain Models
 * Pure TypeScript classes representing business entities
 * Framework-agnostic and database-agnostic
 */

/**
 * Agent Domain Model
 */
declare class Agent {
    id?: string;
    name: string;
    agentType: string;
    locale: string;
    prompt?: string;
    expectedResult?: any;
    tools?: Record<string, any>;
    flows?: AgentFlow[];
    events?: any[];
    settings?: Record<string, any>;
    metadata?: Record<string, any>;
    createdAt?: string;
    updatedAt?: string;
    constructor(config: AgentConfig & {
        createdAt?: string;
        updatedAt?: string;
    });
    /**
     * Convert to AgentConfig for SDK usage
     */
    toConfig(): AgentConfig;
    /**
     * Create from AgentConfig
     */
    static fromConfig(config: AgentConfig): Agent;
}
/**
 * Session Domain Model
 */
declare class Session {
    id: string;
    agentId: string;
    data?: Record<string, any>;
    messages?: any[];
    createdAt: string;
    updatedAt: string;
    constructor(data: {
        id: string;
        agentId: string;
        data?: Record<string, any>;
        messages?: any[];
        createdAt?: string;
        updatedAt?: string;
    });
}
/**
 * Result Domain Model
 */
declare class Result {
    id?: string;
    sessionId: string;
    agentId: string;
    result: any;
    success: boolean;
    error?: string;
    tokensUsed?: number;
    duration?: number;
    createdAt: string;
    constructor(data: {
        id?: string;
        sessionId: string;
        agentId: string;
        result: any;
        success: boolean;
        error?: string;
        tokensUsed?: number;
        duration?: number;
        createdAt?: string;
    });
}
/**
 * Memory Domain Model
 */
declare class Memory {
    id?: string;
    agentId: string;
    sessionId?: string;
    content: string;
    embedding?: number[];
    metadata?: Record<string, any>;
    createdAt: string;
    constructor(data: {
        id?: string;
        agentId: string;
        sessionId?: string;
        content: string;
        embedding?: number[];
        metadata?: Record<string, any>;
        createdAt?: string;
    });
    /**
     * Convenience getter for importance (from metadata)
     */
    get importance(): number;
    /**
     * Convenience getter for access count (from metadata)
     */
    get accessCount(): number;
    /**
     * Convenience getter for accessed at (from metadata)
     */
    get accessedAt(): string | undefined;
}
/**
 * Attachment Domain Model
 */
declare class Attachment {
    id?: number;
    displayName: string;
    description?: string;
    mimeType?: string;
    type?: string;
    size: number;
    storageKey: string;
    filePath?: string;
    content?: string;
    metadata?: Record<string, any>;
    createdAt: string;
    updatedAt: string;
    constructor(data: {
        id?: number;
        displayName: string;
        description?: string;
        mimeType?: string;
        type?: string;
        size: number;
        storageKey: string;
        filePath?: string;
        content?: string;
        metadata?: Record<string, any>;
        createdAt?: string;
        updatedAt?: string;
    });
}

/**
 * Repository Interfaces
 * Define the contract for data access operations
 * Implementation-agnostic (can use Drizzle, Prisma, MongoDB, etc.)
 */

/**
 * Base Repository Interface
 * Provides common CRUD operations
 */
interface BaseRepository<T, TId = string> {
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
interface PaginationOptions {
    page?: number;
    perPage?: number;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
}
/**
 * Paginated Result
 */
interface PaginatedResult<T> {
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
interface AgentRepository extends BaseRepository<Agent> {
    findByType(type: string): Promise<Agent[]>;
    findByName(name: string): Promise<Agent | null>;
    search(query: string): Promise<Agent[]>;
    findWithPagination(options: PaginationOptions): Promise<PaginatedResult<Agent>>;
}
/**
 * Session Repository Interface
 */
interface SessionRepository extends BaseRepository<Session> {
    findByAgentId(agentId: string): Promise<Session[]>;
    findWithMessages(sessionId: string): Promise<Session | null>;
    addMessage(sessionId: string, message: any): Promise<Session>;
    updateData(sessionId: string, data: Record<string, any>): Promise<Session>;
}
/**
 * Result Repository Interface
 */
interface ResultRepository extends BaseRepository<Result> {
    findBySessionId(sessionId: string): Promise<Result | null>;
    findByAgentId(agentId: string): Promise<Result[]>;
    findSuccessful(): Promise<Result[]>;
    findFailed(): Promise<Result[]>;
}
/**
 * Memory Repository Interface
 */
interface MemoryRepository extends BaseRepository<Memory> {
    findByAgentId(agentId: string, limit?: number): Promise<Memory[]>;
    findBySessionId(sessionId: string): Promise<Memory[]>;
    search(agentId: string, query: string, limit?: number): Promise<Memory[]>;
    searchByEmbedding(agentId: string, embedding: number[], limit?: number): Promise<Memory[]>;
}
/**
 * Attachment Repository Interface
 */
interface AttachmentRepository extends BaseRepository<Attachment, number> {
    findByStorageKey(storageKey: string): Promise<Attachment | null>;
    findByType(type: string): Promise<Attachment[]>;
    findWithContent(id: number): Promise<Attachment | null>;
}
/**
 * Repository Collection
 * Container for all repository instances
 */
interface RepositoryCollection {
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
interface RepositoryFactory {
    createAgentRepository(): AgentRepository;
    createSessionRepository(): SessionRepository;
    createResultRepository(): ResultRepository;
    createMemoryRepository(): MemoryRepository;
    createAttachmentRepository(): AttachmentRepository;
    createAll(): RepositoryCollection;
}

/**
 * Mock Repository Implementations
 * In-memory implementations for testing and development
 */

/**
 * Base Mock Repository
 * Provides in-memory storage for testing
 */
declare abstract class BaseMockRepository<T extends {
    id?: any;
    createdAt?: string;
    updatedAt?: string;
}, TId = string> {
    protected items: Map<TId, T>;
    findById(id: TId): Promise<T | null>;
    findMany(filter?: Partial<T>): Promise<T[]>;
    create(data: any): Promise<T>;
    update(id: TId, data: Partial<T>): Promise<T>;
    delete(id: TId): Promise<boolean>;
    count(filter?: Partial<T>): Promise<number>;
    protected abstract generateId(): TId;
    clear(): void;
}
/**
 * Mock Agent Repository
 */
declare class MockAgentRepository extends BaseMockRepository<Agent, string> implements AgentRepository {
    protected generateId(): string;
    findByType(type: string): Promise<Agent[]>;
    findByName(name: string): Promise<Agent | null>;
    search(query: string): Promise<Agent[]>;
    findWithPagination(options: PaginationOptions): Promise<PaginatedResult<Agent>>;
}
/**
 * Mock Session Repository
 */
declare class MockSessionRepository extends BaseMockRepository<Session, string> implements SessionRepository {
    protected generateId(): string;
    findByAgentId(agentId: string): Promise<Session[]>;
    findWithMessages(sessionId: string): Promise<Session | null>;
    addMessage(sessionId: string, message: any): Promise<Session>;
    updateData(sessionId: string, data: Record<string, any>): Promise<Session>;
}
/**
 * Mock Result Repository
 */
declare class MockResultRepository extends BaseMockRepository<Result, string> implements ResultRepository {
    protected generateId(): string;
    findBySessionId(sessionId: string): Promise<Result | null>;
    findByAgentId(agentId: string): Promise<Result[]>;
    findSuccessful(): Promise<Result[]>;
    findFailed(): Promise<Result[]>;
}
/**
 * Mock Memory Repository
 */
declare class MockMemoryRepository extends BaseMockRepository<Memory, string> implements MemoryRepository {
    protected generateId(): string;
    /**
     * Override create to return Memory class instances
     */
    create(data: any): Promise<Memory>;
    /**
     * Override update to maintain Memory class instances
     */
    update(id: string, data: Partial<Memory>): Promise<Memory>;
    findByAgentId(agentId: string, limit?: number): Promise<Memory[]>;
    findBySessionId(sessionId: string): Promise<Memory[]>;
    search(agentId: string, query: string, limit?: number): Promise<Memory[]>;
    searchByEmbedding(agentId: string, embedding: number[], limit?: number): Promise<Memory[]>;
    private cosineSimilarity;
}
/**
 * Mock Attachment Repository
 */
declare class MockAttachmentRepository extends BaseMockRepository<Attachment, number> implements AttachmentRepository {
    private nextId;
    protected generateId(): number;
    findByStorageKey(storageKey: string): Promise<Attachment | null>;
    findByType(type: string): Promise<Attachment[]>;
    findWithContent(id: number): Promise<Attachment | null>;
}

export { Agent, type AgentRepository, Attachment, type AttachmentRepository, type BaseRepository, Memory, type MemoryRepository, MockAgentRepository, MockAttachmentRepository, MockMemoryRepository, MockResultRepository, MockSessionRepository, type PaginatedResult, type PaginationOptions, type RepositoryCollection, type RepositoryFactory, Result, type ResultRepository, Session, type SessionRepository };
