import { AgentConfig } from './agent';
import { PaginationParams, PaginatedResponse } from './common';

/**
 * Base repository interface
 */
export interface IRepository<T, TCreate = T, TUpdate = Partial<T>> {
  findOne(params: Partial<T>): Promise<T | null>;
  findMany(params?: Partial<T> & PaginationParams): Promise<T[]>;
  create(data: TCreate): Promise<T>;
  update(id: string | number, data: TUpdate): Promise<T>;
  delete(id: string | number): Promise<boolean>;
}

/**
 * Agent repository interface
 */
export interface IAgentRepository extends IRepository<AgentConfig> {
  findByType(type: string): Promise<AgentConfig[]>;
}

/**
 * Session data
 */
export interface SessionData {
  id: string;
  agentId: string;
  data?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Session repository interface
 */
export interface ISessionRepository {
  findOne(params: { id: string }): Promise<SessionData | null>;
  create(data: Omit<SessionData, 'createdAt' | 'updatedAt'>): Promise<SessionData>;
  update(id: string, data: Partial<SessionData>): Promise<SessionData>;
}

/**
 * Result data
 */
export interface ResultData {
  id?: string;
  sessionId: string;
  agentId: string;
  result: any;
  success: boolean;
  error?: string;
  tokensUsed?: number;
  duration?: number;
  createdAt: string;
}

/**
 * Result repository interface
 */
export interface IResultRepository {
  findOne(params: { sessionId: string }): Promise<ResultData | null>;
  create(data: Omit<ResultData, 'createdAt'>): Promise<ResultData>;
}

/**
 * All repositories needed by SDK
 */
export interface SDKRepositories {
  agent: IAgentRepository;
  session: ISessionRepository;
  result: IResultRepository;
}
