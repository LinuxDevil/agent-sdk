export { AgentBuilder, ConfigManager, SDKConfig } from './core/index.js';
export { DataLoadingStatus, DeepPartial, IAgentRepository, IRepository, IResultRepository, ISessionRepository, IdEntity, PaginatedResponse, PaginationParams, ResultData, SDKRepositories, SessionData, Timestamped } from './types/index.js';
import { A as AgentTypeDescriptor, a as AgentType, b as AgentConfig } from './agent-DL745E0K.js';
export { e as AgentDefinition, c as AgentExecutionOptions, d as AgentExecutionResult, k as AgentFlow, B as BestOfAllNode, C as ConditionNode, E as EditorStep, p as EvaluatorNode, j as FlowAgentDefinition, f as FlowChunkEvent, F as FlowChunkType, l as FlowExecutionMode, g as FlowInputType, h as FlowInputVariable, m as FlowOutputMode, i as FlowToolSetting, o as ForEachNode, L as LoopNode, O as OneOfNode, P as ParallelNode, n as SequenceNode, S as StepNode, q as ToolNode, T as ToolSetting, U as UIComponentNode } from './agent-DL745E0K.js';
export { I as IToolRegistry, a as ToolConfiguration, T as ToolDescriptor, b as ToolParameter, c as ToolParameters } from './tool-DW-oM1Ru.js';
import { T as ToolRegistry } from './ToolRegistry-D7BQjB9I.js';
export { g as globalToolRegistry } from './ToolRegistry-D7BQjB9I.js';
export { EmailToolOptions, HttpToolOptions, createEmailTool, createHttpTool, currentDateTool, dayNameTool, httpTool } from './tools/index.js';
import { L as LLMProviderConfig, a as LLMProvider, G as GenerateOptions, b as GenerateResult, S as StreamResult, T as ToolCall, M as Message } from './index-DFOCzw_m.js';
export { F as FlowBuilder, c as FlowExecutionContext, e as FlowExecutionEvent, d as FlowExecutionEventType, f as FlowExecutionResult, g as FlowExecutor, I as INPUT_TYPE_LABELS, u as LLMProviderRegistry, p as MessageRole, P as ProviderFactory, t as StreamChunk, s as StreamChunkType, q as ToolDefinition, l as applyInputTransformation, i as convertFromFlowDefinition, h as convertToFlowDefinition, m as createDynamicZodSchemaForInputs, j as extractVariableNames, k as injectVariables, r as replaceVariablesInString, o as validateAgentDefinition, n as validateFlow, v as validateFlowInput } from './index-DFOCzw_m.js';
import { MemoryRepository, Memory } from './data/index.js';
export { Agent, AgentRepository, Attachment, AttachmentRepository, BaseRepository, MockAgentRepository, MockAttachmentRepository, MockMemoryRepository, MockResultRepository, MockSessionRepository, PaginatedResult, PaginationOptions, RepositoryCollection, RepositoryFactory, Result, ResultRepository, Session, SessionRepository } from './data/index.js';
import { ZodError, ZodSchema, z } from 'zod';
import 'ai';

/**
 * Agent types registry
 * Contains all available agent type descriptors
 */
declare const agentTypesRegistry: AgentTypeDescriptor[];
/**
 * Get agent type descriptor by type
 */
declare function getAgentTypeDescriptor(type: AgentType): AgentTypeDescriptor | undefined;
/**
 * Get all agent type descriptors
 */
declare function getAllAgentTypeDescriptors(): AgentTypeDescriptor[];
/**
 * Check if agent type is valid
 */
declare function isValidAgentType(type: string): type is AgentType;

/**
 * Validate agent configuration
 */
declare function validateAgentConfig(config: Partial<AgentConfig>): {
    valid: boolean;
    errors: string[];
};
/**
 * Validate agent tools configuration
 */
declare function validateAgentTools(tools: Record<string, any>): {
    valid: boolean;
    errors: string[];
};

/**
 * Mock LLM Provider
 * For testing and development
 */

/**
 * Mock response configuration
 */
interface MockProviderConfig extends LLMProviderConfig {
    responses?: string[];
    delay?: number;
    simulateError?: boolean;
    errorMessage?: string;
}
/**
 * Mock LLM Provider
 */
declare class MockLLMProvider implements LLMProvider {
    readonly name = "mock";
    private responseIndex;
    private responses;
    private delay;
    private simulateError;
    private errorMessage;
    constructor(config: MockProviderConfig);
    generate(options: GenerateOptions): Promise<GenerateResult>;
    stream(options: GenerateOptions): Promise<StreamResult>;
    supportsTools(model: string): boolean;
    supportsStreaming(model: string): boolean;
    getModels(): Promise<string[]>;
    private getNextResponse;
    private extractToolCalls;
    private countTokens;
}
/**
 * Create mock provider
 */
declare function createMockProvider(config?: MockProviderConfig): MockLLMProvider;

/**
 * OpenAI Provider Implementation
 * Uses the 'ai' SDK for unified interface
 */

interface OpenAIProviderConfig extends LLMProviderConfig {
    apiKey: string;
    organization?: string;
    baseURL?: string;
    defaultModel?: string;
}
/**
 * OpenAI Provider using the 'ai' SDK
 */
declare class OpenAIProvider implements LLMProvider {
    readonly name = "openai";
    private provider;
    private config;
    constructor(config: OpenAIProviderConfig);
    /**
     * Generate text without streaming
     */
    generate(options: GenerateOptions): Promise<GenerateResult>;
    /**
     * Generate text with streaming
     */
    stream(options: GenerateOptions): Promise<StreamResult>;
    /**
     * Check if model supports tools
     */
    supportsTools(model: string): boolean;
    /**
     * Check if model supports streaming
     */
    supportsStreaming(model: string): boolean;
    /**
     * Get available models
     */
    getModels(): Promise<string[]>;
}

/**
 * Ollama Provider Implementation
 * Uses the 'ai' SDK with ollama-ai-provider
 */

interface OllamaProviderConfig extends LLMProviderConfig {
    baseURL?: string;
    defaultModel?: string;
}
/**
 * Ollama Provider using the 'ai' SDK
 */
declare class OllamaProvider implements LLMProvider {
    readonly name = "ollama";
    private provider;
    private config;
    constructor(config: OllamaProviderConfig);
    /**
     * Generate text without streaming
     */
    generate(options: GenerateOptions): Promise<GenerateResult>;
    /**
     * Generate text with streaming
     */
    stream(options: GenerateOptions): Promise<StreamResult>;
    /**
     * Check if model supports tools
     */
    supportsTools(model: string): boolean;
    /**
     * Check if model supports streaming
     */
    supportsStreaming(model: string): boolean;
    /**
     * Get available models
     */
    getModels(): Promise<string[]>;
}

/**
 * Agent Executor
 * Executes agents with streaming support and tool calling
 */

/**
 * Execution event types
 */
type ExecutionEventType = 'start' | 'text-delta' | 'text-complete' | 'tool-call' | 'tool-result' | 'finish' | 'error';
/**
 * Execution event
 */
interface ExecutionEvent {
    type: ExecutionEventType;
    timestamp: Date;
    agentId?: string;
    agentName?: string;
    textDelta?: string;
    text?: string;
    toolCall?: ToolCall;
    toolResult?: {
        toolCallId: string;
        toolName: string;
        result: any;
        error?: string;
    };
    finishReason?: string;
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
    error?: Error;
}
/**
 * Execution options
 */
interface ExecuteOptions {
    agent: AgentConfig;
    input: string | Message[];
    provider: LLMProvider;
    toolRegistry?: ToolRegistry;
    streaming?: boolean;
    maxSteps?: number;
    temperature?: number;
    maxTokens?: number;
    onEvent?: (event: ExecutionEvent) => void;
}
/**
 * Execution result
 */
interface ExecutionResult {
    text: string;
    messages: Message[];
    toolCalls: ToolCall[];
    usage: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
    finishReason: string;
    steps: number;
}
/**
 * Agent Executor
 */
declare class AgentExecutor {
    /**
     * Execute agent without streaming
     */
    static execute(options: ExecuteOptions): Promise<ExecutionResult>;
    /**
     * Build messages from input
     */
    private static buildMessages;
    /**
     * Build tools from agent and registry
     */
    private static buildTools;
    /**
     * Execute a tool call
     */
    private static executeToolCall;
    /**
     * Emit event to callback
     */
    private static emitEvent;
}

/**
 * Memory Manager
 * Manages agent memories with relevance-based recall
 */

/**
 * Memory manager configuration
 */
interface MemoryManagerConfig {
    repository: MemoryRepository;
    maxMemories?: number;
    relevanceThreshold?: number;
}
/**
 * Store memory options
 */
interface StoreMemoryOptions {
    agentId: string;
    content: string;
    metadata?: Record<string, any>;
    embedding?: number[];
    importance?: number;
}
/**
 * Recall memory options
 */
interface RecallMemoryOptions {
    agentId: string;
    query?: string;
    embedding?: number[];
    limit?: number;
    minRelevance?: number;
}
/**
 * Memory search result
 */
interface MemorySearchResult {
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
declare class MemoryManager {
    private config;
    constructor(config: MemoryManagerConfig);
    /**
     * Store a new memory
     */
    store(options: StoreMemoryOptions): Promise<Memory>;
    /**
     * Recall relevant memories
     */
    recall(options: RecallMemoryOptions): Promise<MemorySearchResult[]>;
    /**
     * Search memories by embedding (vector similarity)
     */
    searchByEmbedding(agentId: string, embedding: number[], limit?: number): Promise<MemorySearchResult[]>;
    /**
     * Get memory by ID
     */
    getById(id: string): Promise<Memory | null>;
    /**
     * Update memory
     */
    update(id: string, updates: Partial<Memory>): Promise<Memory>;
    /**
     * Delete memory
     */
    delete(id: string): Promise<void>;
    /**
     * Delete all memories for an agent
     */
    deleteAllForAgent(agentId: string): Promise<void>;
    /**
     * Get memory statistics for an agent
     */
    getStats(agentId: string): Promise<{
        total: number;
        avgImportance: number;
        avgAccessCount: number;
        oldestMemory: string | null;
        newestMemory: string | null;
    }>;
    /**
     * Calculate relevance score for a memory
     */
    private calculateRelevance;
    /**
     * Calculate cosine similarity between two embeddings
     */
    private calculateEmbeddingSimilarity;
    /**
     * Calculate text similarity (simple keyword matching)
     */
    private calculateTextSimilarity;
    /**
     * Update access statistics for a memory
     */
    private updateAccessStats;
    /**
     * Prune old memories if limit is exceeded
     */
    private pruneMemoriesIfNeeded;
}

/**
 * Context Builder
 * Builds execution context for agent runs
 */

/**
 * Context builder options
 */
interface ContextBuilderOptions {
    agent: AgentConfig;
    input: string | Message[];
    sessionHistory?: Message[];
    memoryManager?: MemoryManager;
    variables?: Record<string, any>;
    systemPrompt?: string;
    maxHistoryMessages?: number;
    maxMemories?: number;
}
/**
 * Built context
 */
interface ExecutionContext {
    messages: Message[];
    variables: Record<string, any>;
    systemPrompt: string;
    metadata: {
        agentId: string;
        agentName: string;
        agentType: string;
        hasMemories: boolean;
        memoryCount: number;
        historyCount: number;
    };
}
/**
 * Context Builder
 *
 * Builds execution context from agent config, input, session history, and memories.
 *
 * @example
 * ```typescript
 * const context = await ContextBuilder.build({
 *   agent: myAgent,
 *   input: 'Hello!',
 *   sessionHistory: previousMessages,
 *   memoryManager,
 *   variables: { userName: 'Alice' },
 * });
 *
 * // Use context in execution
 * const result = await provider.generate({
 *   messages: context.messages,
 *   temperature: 0.7,
 * });
 * ```
 */
declare class ContextBuilder {
    /**
     * Build execution context
     */
    static build(options: ContextBuilderOptions): Promise<ExecutionContext>;
    /**
     * Build system prompt with agent instructions and memories
     */
    private static buildSystemPrompt;
    /**
     * Build message array from input and history
     */
    private static buildMessages;
    /**
     * Inject variables into messages
     */
    private static injectVariables;
    /**
     * Interpolate variables in text ({{variable}} syntax)
     */
    private static interpolateVariables;
    /**
     * Merge multiple contexts (useful for multi-agent scenarios)
     */
    static merge(...contexts: ExecutionContext[]): ExecutionContext;
    /**
     * Clone context with modifications
     */
    static clone(context: ExecutionContext, modifications?: Partial<ExecutionContext>): ExecutionContext;
    /**
     * Extract variables from context messages
     */
    static extractVariables(context: ExecutionContext): string[];
    /**
     * Validate context has all required variables
     */
    static validate(context: ExecutionContext): {
        valid: boolean;
        missingVariables: string[];
    };
}

/**
 * Error Classes
 * Custom error types for SDK operations
 */
/**
 * Base SDK error
 */
declare class SDKError extends Error {
    readonly code?: string | undefined;
    constructor(message: string, code?: string | undefined);
}
/**
 * Agent execution error
 */
declare class AgentExecutionError extends SDKError {
    readonly agentId?: string | undefined;
    readonly cause?: Error | undefined;
    constructor(message: string, agentId?: string | undefined, cause?: Error | undefined);
}
/**
 * Tool execution error
 */
declare class ToolExecutionError extends SDKError {
    readonly toolName?: string | undefined;
    readonly cause?: Error | undefined;
    constructor(message: string, toolName?: string | undefined, cause?: Error | undefined);
}
/**
 * LLM provider error
 */
declare class LLMProviderError extends SDKError {
    readonly providerName?: string | undefined;
    readonly statusCode?: number | undefined;
    readonly cause?: Error | undefined;
    constructor(message: string, providerName?: string | undefined, statusCode?: number | undefined, cause?: Error | undefined);
}
/**
 * Flow execution error
 */
declare class FlowExecutionError extends SDKError {
    readonly flowCode?: string | undefined;
    readonly step?: string | undefined;
    readonly cause?: Error | undefined;
    constructor(message: string, flowCode?: string | undefined, step?: string | undefined, cause?: Error | undefined);
}
/**
 * Configuration error
 */
declare class ConfigurationError extends SDKError {
    readonly field?: string | undefined;
    constructor(message: string, field?: string | undefined);
}
/**
 * Validation error
 */
declare class ValidationError extends SDKError {
    readonly errors?: Record<string, string[]> | undefined;
    constructor(message: string, errors?: Record<string, string[]> | undefined);
}
/**
 * Timeout error
 */
declare class TimeoutError extends SDKError {
    readonly timeoutMs?: number | undefined;
    readonly operation?: string | undefined;
    constructor(message: string, timeoutMs?: number | undefined, operation?: string | undefined);
}
/**
 * Rate limit error
 */
declare class RateLimitError extends SDKError {
    readonly retryAfter?: number | undefined;
    readonly limit?: number | undefined;
    constructor(message: string, retryAfter?: number | undefined, limit?: number | undefined);
}
/**
 * Check if error is retryable
 */
declare function isRetryableError(error: Error): boolean;
/**
 * Check if error is a network error
 */
declare function isNetworkError(error: Error): boolean;
/**
 * Extract retry delay from error (for rate limiting)
 */
declare function getRetryDelay(error: Error): number | undefined;

/**
 * Retry Logic
 * Exponential backoff and retry utilities
 */
/**
 * Retry options
 */
interface RetryOptions {
    maxAttempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    backoffMultiplier?: number;
    timeout?: number;
    onRetry?: (error: Error, attempt: number, delayMs: number) => void;
    shouldRetry?: (error: Error, attempt: number) => boolean;
}
/**
 * Retry result
 */
interface RetryResult<T> {
    value: T;
    attempts: number;
    totalDelayMs: number;
}
/**
 * Retry an async operation with exponential backoff
 *
 * @example
 * ```typescript
 * const result = await retry(
 *   async () => {
 *     return await provider.generate({ messages });
 *   },
 *   {
 *     maxAttempts: 3,
 *     initialDelayMs: 1000,
 *     onRetry: (error, attempt, delay) => {
 *       console.log(`Retry attempt ${attempt} after ${delay}ms: ${error.message}`);
 *     },
 *   }
 * );
 * ```
 */
declare function retry<T>(operation: () => Promise<T>, options?: RetryOptions): Promise<RetryResult<T>>;
/**
 * Retry with specific error types
 */
declare function retryOnError<T>(operation: () => Promise<T>, errorTypes: (new (...args: any[]) => Error)[], options?: RetryOptions): Promise<RetryResult<T>>;
/**
 * Retry with timeout for each attempt
 */
declare function retryWithTimeout<T>(operation: () => Promise<T>, timeoutMs: number, options?: RetryOptions): Promise<RetryResult<T>>;
/**
 * Batch retry multiple operations
 */
declare function retryBatch<T>(operations: Array<() => Promise<T>>, options?: RetryOptions): Promise<Array<RetryResult<T>>>;
/**
 * Retry with exponential backoff and circuit breaker
 */
declare class RetryableOperation<T> {
    private operation;
    private options;
    private failureCount;
    private lastFailureTime;
    private circuitBreakerThreshold;
    private circuitBreakerResetMs;
    constructor(operation: () => Promise<T>, options?: RetryOptions & {
        circuitBreakerThreshold?: number;
        circuitBreakerResetMs?: number;
    });
    execute(): Promise<RetryResult<T>>;
    private isCircuitOpen;
    private recordFailure;
    reset(): void;
    getStatus(): {
        isOpen: boolean;
        failureCount: number;
        lastFailureTime: number | null;
    };
}

/**
 * Security types and interfaces
 */
/**
 * Configuration for encryption operations
 */
interface EncryptionConfig {
    secretKey: string;
    algorithm?: string;
    iterations?: number;
}
/**
 * Settings for DTO encryption
 */
interface DTOEncryptionSettings {
    encryptedFields: string[];
}
/**
 * Quota configuration for SaaS mode
 */
interface QuotaConfig {
    allowedResults?: number;
    allowedSessions?: number;
    allowedUSDBudget?: number;
}
/**
 * Current usage statistics
 */
interface UsageStats {
    usedResults?: number;
    usedSessions?: number;
    usedUSDBudget?: number;
}
/**
 * Authorization context for requests
 */
interface AuthorizationContext {
    userId?: string;
    databaseIdHash: string;
    permissions: string[];
}
/**
 * SaaS context with quota and usage information
 */
interface SaaSContext {
    emailVerified: boolean;
    currentQuota: QuotaConfig;
    currentUsage: UsageStats;
}
/**
 * Result of quota validation
 */
interface QuotaValidationResult {
    message: string;
    status: number;
}

/**
 * Cryptographic utilities for encryption, decryption, and hashing
 */

/**
 * Encryption utility class using AES-GCM encryption
 */
declare class EncryptionUtils {
    private key;
    private secretKey;
    private keyGenerated;
    constructor(secretKey: string);
    /**
     * Generate or retrieve cached encryption key
     */
    generateKey(secretKey: string): Promise<void>;
    /**
     * Derive encryption key from secret using PBKDF2
     */
    private deriveKey;
    /**
     * Encrypt ArrayBuffer data
     */
    encryptArrayBuffer(data: ArrayBuffer): Promise<ArrayBuffer>;
    /**
     * Convert Blob to ArrayBuffer
     */
    blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer>;
    /**
     * Decrypt ArrayBuffer data
     */
    decryptArrayBuffer(encryptedData: ArrayBuffer | Blob): Promise<ArrayBuffer>;
    /**
     * Encrypt string text
     */
    encrypt(text: string): Promise<string>;
    /**
     * Decrypt string text
     */
    decrypt(cipherText: string): Promise<string>;
}
/**
 * Generate a random password
 */
declare function generatePassword(): string;
/**
 * DTO encryption filter for encrypting/decrypting object fields
 */
declare class DTOEncryptionFilter<T> {
    private utils;
    constructor(secretKey: string);
    /**
     * Encrypt specified fields in a DTO
     */
    encrypt(dto: T, encryptionSettings?: DTOEncryptionSettings): Promise<T>;
    /**
     * Decrypt specified fields in a DTO
     */
    decrypt(dto: T, encryptionSettings?: DTOEncryptionSettings): Promise<T>;
    /**
     * Process DTO fields with a transformation function
     */
    private process;
}
/**
 * Generate SHA-256 hash with salt
 */
declare function sha256(message: string, salt: string): Promise<string>;

/**
 * Quota validation utilities for SaaS mode
 */

/**
 * Validate token quotas against current usage
 * Returns a validation result with status code and message
 *
 * @param saasContext - SaaS context containing quota and usage information
 * @param isSaaSEnabled - Whether SaaS mode is enabled (default: false)
 * @returns Validation result with message and HTTP status code
 */
declare function validateTokenQuotas(saasContext: SaaSContext | undefined, isSaaSEnabled?: boolean): QuotaValidationResult;

/**
 * Storage types and interfaces
 */
/**
 * Storage service interface for file operations
 */
interface IStorageService {
    /**
     * Read file as ArrayBuffer
     */
    readAttachment(key: string): ArrayBuffer;
    /**
     * Read file as base64 data URI with MIME type
     */
    readAttachmentAsBase64WithMimeType(key: string, mimeType: string): string;
    /**
     * Read plain text file
     */
    readPlainTextAttachment(key: string): string;
    /**
     * Read JSON file
     */
    readPlainJSONAttachment<T = any>(key: string): T;
    /**
     * Save file from File object
     */
    saveAttachment(file: File, key: string): Promise<void>;
    /**
     * Save file from base64 string
     */
    saveAttachmentFromBase64(base64: string, key: string): Promise<void>;
    /**
     * Save plain text file
     */
    savePlainTextAttachment(text: string, key: string): Promise<void>;
    /**
     * Write JSON file
     */
    writePlainJSONAttachment(key: string, data: any, maxFileSizeMB?: number): void;
    /**
     * Delete file
     */
    deleteAttachment(key: string): void;
    /**
     * Check if file exists
     */
    fileExists(key: string): boolean;
    /**
     * Acquire lock on a file
     */
    acquireLock(key: string, maxAttempts?: number, attemptDelayMs?: number): Promise<void>;
    /**
     * Release lock on a file
     */
    releaseLock(key: string): void;
}
/**
 * Storage configuration
 */
interface StorageConfig {
    rootPath?: string;
    schema: string;
    databaseIdHash: string;
}

/**
 * File storage service with locking mechanism
 *
 * Provides file I/O operations with concurrency control using file locks.
 * Supports binary, text, and JSON file operations.
 */

/**
 * Storage service for managing file operations with locking
 *
 * Note: This is a framework-agnostic interface. Actual implementations
 * should be provided by the consuming application (e.g., Node.js fs-based,
 * cloud storage, etc.)
 */
declare class StorageService implements IStorageService {
    private rootPath;
    private uploadPath;
    private schema;
    private fs;
    private path;
    constructor(databaseIdHash: string, schema: string, fs: any, path: any, rootPath?: string);
    /**
     * Ensures that the target directory (uploadPath) exists.
     */
    private ensureDirExists;
    /**
     * Resolve the absolute path for a particular storage key (file name).
     */
    private getFilePath;
    /**
     * Resolve the absolute path for the lock file used by concurrency.
     */
    private getLockFilePath;
    /**
     * Simple helper to wait between lock acquisition attempts.
     */
    private delay;
    /**
     * Acquire an exclusive lock on a file by creating a ".lock" next to it.
     */
    acquireLock(storageKey: string, maxAttempts?: number, attemptDelayMs?: number): Promise<void>;
    /**
     * Release the lock by removing the ".lock" file.
     */
    releaseLock(storageKey: string): void;
    /**
     * Save a binary attachment from a File object (browser File).
     */
    saveAttachment(file: File, storageKey: string): Promise<void>;
    /**
     * Save a binary attachment from a base64 string.
     */
    saveAttachmentFromBase64(base64: string, storageKey: string): Promise<void>;
    /**
     * Save a plain-text file (UTF-8).
     */
    savePlainTextAttachment(text: string, storageKey: string): Promise<void>;
    /**
     * Read a plain-text file (UTF-8).
     */
    readPlainTextAttachment(storageKey: string): string;
    /**
     * Check if a file exists.
     */
    fileExists(storageKey: string): boolean;
    /**
     * Read a binary attachment as an ArrayBuffer.
     */
    readAttachment(storageKey: string): ArrayBuffer;
    /**
     * Read a binary attachment as a base64 data URI string (with mimeType).
     */
    readAttachmentAsBase64WithMimeType(storageKey: string, mimeType: string): string;
    /**
     * Delete a file by its storage key.
     */
    deleteAttachment(storageKey: string): void;
    /**
     * Read a JSON file from disk and parse it. Returns {} if not found.
     */
    readPlainJSONAttachment<T = any>(storageKey: string): T;
    /**
     * Writes data as JSON to disk. Checks size against maxFileSizeMB (default 10).
     */
    writePlainJSONAttachment(storageKey: string, data: any, maxFileSizeMB?: number): void;
}

/**
 * Template types and interfaces
 */
/**
 * Filter function for template variables
 */
type TemplateFilter = (arg: any) => string;
/**
 * Template rendering context
 */
type TemplateContext = Record<string, any>;
/**
 * Template rendering options
 */
interface TemplateOptions {
    /**
     * Custom filters for template variables
     */
    customFilters?: Record<string, TemplateFilter>;
    /**
     * Whether to escape HTML by default
     */
    autoEscape?: boolean;
}
/**
 * Template manager interface
 */
interface ITemplateManager {
    /**
     * Render a template string with context
     */
    render(template: string, context: TemplateContext, options?: TemplateOptions): string;
    /**
     * Load and render a template file
     */
    renderFile?(filePath: string, context: TemplateContext, options?: TemplateOptions): Promise<string>;
}

/**
 * Template rendering engine
 *
 * Supports Jinja2-like syntax:
 * - Variables: {{ variable }}, {{ variable|filter }}
 * - Conditionals: {% if condition %}...{% else %}...{% endif %}
 * - Loops: {% for item in items %}...{% else %}...{% endfor %}
 */

/**
 * Template manager implementation
 */
declare class TemplateManager implements ITemplateManager {
    /**
     * Render a template string with context
     */
    render(template: string, context: TemplateContext, options?: TemplateOptions): string;
    /**
     * Render template with a simple function interface
     */
    static renderTemplate(template: string, context: TemplateContext, customFilters?: Record<string, TemplateFilter>): string;
}
/**
 * Convenience function to render a template
 */
declare function renderTemplate(template: string, context: TemplateContext, customFilters?: Record<string, TemplateFilter>): string;

/**
 * Recursively traverses the given object (and its children via "input" and "item")
 * updating each node's "name" property to reflect the path of agents from the root.
 */
declare function setRecursiveNames(obj: any, path?: string[]): void;
/**
 * Get an object property by JSON path notation (e.g., "$.user.name" or "$.items[0]")
 * @param obj - The object to traverse
 * @param path - The JSON path string starting with "$"
 * @returns The value at the specified path or undefined if not found
 */
declare function getObjectByPath(obj: any, path: string): any;

/**
 * Get error message from any error type
 */
declare function getErrorMessage(error: unknown): string;
/**
 * Format Zod validation error
 */
declare function formatZodError(err: unknown): {
    type: string;
    message: string;
    [key: string]: any;
};
/**
 * Get Zod error message (simple format)
 */
declare function getZodErrorMessage(error: ZodError): string;
/**
 * Format Axios error (if axios is being used)
 */
declare function formatAxiosError(error: any): string;

/**
 * Get current timestamp in formatted string
 */
declare function getCurrentTS(): string;
/**
 * Format date to timestamp string (YYYY-MM-DD HH:MM:SS)
 */
declare function getTS(now?: Date): string;
/**
 * Format date to locale string
 */
declare function formatDate(date: Date): string;
/**
 * Safe JSON parse with default value
 */
declare function safeJsonParse<T = any>(str: string, defaultValue: T): T;
/**
 * Remove markdown code blocks from text
 */
declare function removeCodeBlocks(text: string): string;
interface CodeBlock {
    line: number;
    position: number;
    syntax: string;
    block: string;
    code: string;
}
interface CodeBlockError {
    line: number;
    position: number;
    message: string;
    block: string;
}
interface CodeBlockResult {
    errors: CodeBlockError[];
    blocks: CodeBlock[];
}
/**
 * Find and extract code blocks from markdown text
 */
declare function findCodeBlocks(block: string, singleBlockMode?: boolean): CodeBlockResult;
/**
 * Check if API key is provided, throw error if not
 */
declare function checkApiKey(name: string, key: string, value: string): string;

/**
 * Validate data against a Zod schema
 */
declare function validateWithSchema<T>(schema: ZodSchema<T>, data: unknown): T;
/**
 * Safe validation that returns result with success flag
 */
declare function safeValidate<T>(schema: ZodSchema<T>, data: unknown): {
    success: true;
    data: T;
} | {
    success: false;
    error: z.ZodError;
};
/**
 * Check if value is a valid email
 */
declare function isValidEmail(email: string): boolean;
/**
 * Check if value is a valid URL
 */
declare function isValidUrl(url: string): boolean;
/**
 * Check if value is a valid JSON string
 */
declare function isValidJson(str: string): boolean;
/**
 * Sanitize string for safe output (basic HTML escape)
 */
declare function sanitizeString(str: string): string;
/**
 * Validate that object has required keys
 */
declare function hasRequiredKeys<T extends Record<string, any>>(obj: T, requiredKeys: (keyof T)[]): boolean;

/**
 * File extraction and processing utilities
 * Handles conversion of various file formats (PDF, Office docs, etc.) to text or images
 */
interface ProcessFilesParams {
    inputObject: Record<string, string | string[]>;
    pdfExtractText?: boolean;
}
/**
 * Get MIME type from base64 data URI
 */
declare function getMimeType(base64Data: string): string | null;
/**
 * Get file extension from MIME type
 */
declare function getFileExtensionFromMimeType(mimeType: string): string;
/**
 * Replace base64 content in strings with a placeholder
 * Useful for logging and debugging without exposing large binary data
 */
declare function replaceBase64Content(data: string): string;
/**
 * Check if buffer contains binary data (non-printable characters)
 */
declare function isBinaryData(buffer: any): boolean;
/**
 * Extract base64 data part from data URI
 */
declare function extractBase64Data(base64Str: string): string;
/**
 * Create a data URI from MIME type and base64 data
 */
declare function createDataUri(mimeType: string, base64Data: string): string;

/**
 * Build AI Agent SDK
 * Framework-agnostic SDK for building AI agents
 *
 * @packageDocumentation
 */
declare const VERSION = "1.0.0-alpha.8";

export { AgentConfig, AgentExecutionError, AgentExecutor, AgentType, AgentTypeDescriptor, type AuthorizationContext, type CodeBlock, type CodeBlockError, type CodeBlockResult, ConfigurationError, ContextBuilder, type ContextBuilderOptions, DTOEncryptionFilter, type DTOEncryptionSettings, type EncryptionConfig, EncryptionUtils, type ExecuteOptions, type ExecutionContext, type ExecutionEvent, type ExecutionEventType, type ExecutionResult, FlowExecutionError, GenerateOptions, GenerateResult, type IStorageService, type ITemplateManager, LLMProvider, LLMProviderConfig, LLMProviderError, Memory, MemoryManager, type MemoryManagerConfig, MemoryRepository, type MemorySearchResult, Message, MockLLMProvider, type MockProviderConfig, OllamaProvider, type OllamaProviderConfig, OpenAIProvider, type OpenAIProviderConfig, type ProcessFilesParams, type QuotaConfig, type QuotaValidationResult, RateLimitError, type RecallMemoryOptions, type RetryOptions, type RetryResult, RetryableOperation, SDKError, type SaaSContext, type StorageConfig, StorageService, type StoreMemoryOptions, StreamResult, type TemplateContext, type TemplateFilter, TemplateManager, type TemplateOptions, TimeoutError, ToolCall, ToolExecutionError, ToolRegistry, type UsageStats, VERSION, ValidationError, agentTypesRegistry, checkApiKey, createDataUri, createMockProvider, extractBase64Data, findCodeBlocks, formatAxiosError, formatDate, formatZodError, generatePassword, getAgentTypeDescriptor, getAllAgentTypeDescriptors, getCurrentTS, getErrorMessage, getFileExtensionFromMimeType, getMimeType, getObjectByPath, getRetryDelay, getTS, getZodErrorMessage, hasRequiredKeys, isBinaryData, isNetworkError, isRetryableError, isValidAgentType, isValidEmail, isValidJson, isValidUrl, removeCodeBlocks, renderTemplate, replaceBase64Content, retry, retryBatch, retryOnError, retryWithTimeout, safeJsonParse, safeValidate, sanitizeString, setRecursiveNames, sha256, validateAgentConfig, validateAgentTools, validateTokenQuotas, validateWithSchema };
