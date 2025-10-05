import { b as AgentConfig } from '../agent-DL745E0K.js';
export { e as AgentDefinition, c as AgentExecutionOptions, d as AgentExecutionResult, k as AgentFlow, a as AgentType, A as AgentTypeDescriptor, B as BestOfAllNode, C as ConditionNode, E as EditorStep, p as EvaluatorNode, j as FlowAgentDefinition, f as FlowChunkEvent, F as FlowChunkType, l as FlowExecutionMode, g as FlowInputType, h as FlowInputVariable, m as FlowOutputMode, i as FlowToolSetting, o as ForEachNode, L as LoopNode, O as OneOfNode, P as ParallelNode, n as SequenceNode, S as StepNode, q as ToolNode, T as ToolSetting, U as UIComponentNode } from '../agent-DL745E0K.js';
export { I as IToolRegistry, a as ToolConfiguration, T as ToolDescriptor, b as ToolParameter, c as ToolParameters } from '../tool-DW-oM1Ru.js';
import 'ai';

/**
 * Common types used throughout the SDK
 */
declare enum DataLoadingStatus {
    Idle = "idle",
    Loading = "loading",
    Success = "success",
    Error = "error"
}
interface PaginationParams {
    page?: number;
    perPage?: number;
}
interface PaginatedResponse<T> {
    data: T[];
    total: number;
    page: number;
    perPage: number;
    hasMore: boolean;
}
type DeepPartial<T> = {
    [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};
interface Timestamped {
    createdAt: string;
    updatedAt: string;
}
interface IdEntity {
    id?: string | number;
}

/**
 * Base repository interface
 */
interface IRepository<T, TCreate = T, TUpdate = Partial<T>> {
    findOne(params: Partial<T>): Promise<T | null>;
    findMany(params?: Partial<T> & PaginationParams): Promise<T[]>;
    create(data: TCreate): Promise<T>;
    update(id: string | number, data: TUpdate): Promise<T>;
    delete(id: string | number): Promise<boolean>;
}
/**
 * Agent repository interface
 */
interface IAgentRepository extends IRepository<AgentConfig> {
    findByType(type: string): Promise<AgentConfig[]>;
}
/**
 * Session data
 */
interface SessionData {
    id: string;
    agentId: string;
    data?: Record<string, any>;
    createdAt: string;
    updatedAt: string;
}
/**
 * Session repository interface
 */
interface ISessionRepository {
    findOne(params: {
        id: string;
    }): Promise<SessionData | null>;
    create(data: Omit<SessionData, 'createdAt' | 'updatedAt'>): Promise<SessionData>;
    update(id: string, data: Partial<SessionData>): Promise<SessionData>;
}
/**
 * Result data
 */
interface ResultData {
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
interface IResultRepository {
    findOne(params: {
        sessionId: string;
    }): Promise<ResultData | null>;
    create(data: Omit<ResultData, 'createdAt'>): Promise<ResultData>;
}
/**
 * All repositories needed by SDK
 */
interface SDKRepositories {
    agent: IAgentRepository;
    session: ISessionRepository;
    result: IResultRepository;
}

export { AgentConfig, DataLoadingStatus, type DeepPartial, type IAgentRepository, type IRepository, type IResultRepository, type ISessionRepository, type IdEntity, type PaginatedResponse, type PaginationParams, type ResultData, type SDKRepositories, type SessionData, type Timestamped };
