/**
 * Domain Models
 * Pure TypeScript classes representing business entities
 * Framework-agnostic and database-agnostic
 */

import { AgentConfig, AgentFlow } from '../types';

/**
 * Agent Domain Model
 */
export class Agent {
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

  constructor(config: AgentConfig & { createdAt?: string; updatedAt?: string }) {
    this.id = config.id;
    this.name = config.name;
    this.agentType = config.agentType;
    this.locale = config.locale || 'en';
    this.prompt = config.prompt;
    this.expectedResult = config.expectedResult;
    this.tools = config.tools;
    this.flows = config.flows;
    this.events = config.events;
    this.settings = config.settings;
    this.metadata = config.metadata;
    this.createdAt = config.createdAt;
    this.updatedAt = config.updatedAt;
  }

  /**
   * Convert to AgentConfig for SDK usage
   */
  toConfig(): AgentConfig {
    return {
      id: this.id,
      name: this.name,
      agentType: this.agentType as any,
      locale: this.locale,
      prompt: this.prompt,
      expectedResult: this.expectedResult,
      tools: this.tools,
      flows: this.flows,
      events: this.events,
      settings: this.settings,
      metadata: this.metadata,
    };
  }

  /**
   * Create from AgentConfig
   */
  static fromConfig(config: AgentConfig): Agent {
    return new Agent(config);
  }
}

/**
 * Session Domain Model
 */
export class Session {
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
  }) {
    this.id = data.id;
    this.agentId = data.agentId;
    this.data = data.data;
    this.messages = data.messages;
    this.createdAt = data.createdAt || new Date().toISOString();
    this.updatedAt = data.updatedAt || new Date().toISOString();
  }
}

/**
 * Result Domain Model
 */
export class Result {
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
  }) {
    this.id = data.id;
    this.sessionId = data.sessionId;
    this.agentId = data.agentId;
    this.result = data.result;
    this.success = data.success;
    this.error = data.error;
    this.tokensUsed = data.tokensUsed;
    this.duration = data.duration;
    this.createdAt = data.createdAt || new Date().toISOString();
  }
}

/**
 * Memory Domain Model
 */
export class Memory {
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
  }) {
    this.id = data.id;
    this.agentId = data.agentId;
    this.sessionId = data.sessionId;
    this.content = data.content;
    this.embedding = data.embedding;
    this.metadata = data.metadata;
    this.createdAt = data.createdAt || new Date().toISOString();
  }

  /**
   * Convenience getter for importance (from metadata)
   */
  get importance(): number {
    return this.metadata?.importance ?? 1;
  }

  /**
   * Convenience getter for access count (from metadata)
   */
  get accessCount(): number {
    return this.metadata?.accessCount ?? 0;
  }

  /**
   * Convenience getter for accessed at (from metadata)
   */
  get accessedAt(): string | undefined {
    return this.metadata?.accessedAt;
  }
}

/**
 * Attachment Domain Model
 */
export class Attachment {
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
  }) {
    this.id = data.id;
    this.displayName = data.displayName;
    this.description = data.description;
    this.mimeType = data.mimeType;
    this.type = data.type;
    this.size = data.size;
    this.storageKey = data.storageKey;
    this.filePath = data.filePath;
    this.content = data.content;
    this.metadata = data.metadata;
    this.createdAt = data.createdAt || new Date().toISOString();
    this.updatedAt = data.updatedAt || new Date().toISOString();
  }
}
