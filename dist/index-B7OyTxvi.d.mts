import { h as FlowInputVariable, E as EditorStep, k as AgentFlow, b as AgentConfig, g as FlowInputType, j as FlowAgentDefinition } from './agent-VJBGMswO.mjs';
import { T as ToolRegistry } from './ToolRegistry-lDQ_JocJ.mjs';
import { z } from 'zod';

/**
 * FlowBuilder
 * Fluent API for building flow definitions
 */
declare class FlowBuilder {
    private flow;
    /**
     * Set flow ID
     */
    setId(id: string): this;
    /**
     * Set flow code (unique identifier)
     */
    setCode(code: string): this;
    /**
     * Set flow name
     */
    setName(name: string): this;
    /**
     * Set flow description
     */
    setDescription(description: string): this;
    /**
     * Add an input variable
     */
    addInput(input: FlowInputVariable): this;
    /**
     * Set all input variables
     */
    setInputs(inputs: FlowInputVariable[]): this;
    /**
     * Set the flow definition
     */
    setFlow(flow: EditorStep): this;
    /**
     * Add an agent definition
     */
    addAgent(agent: any): this;
    /**
     * Set all agents
     */
    setAgents(agents: any[]): this;
    /**
     * Build the flow
     */
    build(): AgentFlow;
    /**
     * Validate the flow configuration
     */
    private validate;
    /**
     * Create a builder from existing flow
     */
    static from(flow: AgentFlow): FlowBuilder;
    /**
     * Create a new builder instance
     */
    static create(): FlowBuilder;
}

/**
 * LLM Provider Abstraction
 * Framework-agnostic interface for LLM providers
 */
/**
 * Message role types
 */
type MessageRole = 'system' | 'user' | 'assistant' | 'tool';
/**
 * Message structure
 */
interface Message {
    role: MessageRole;
    content: string;
    name?: string;
    toolCallId?: string;
    toolCalls?: ToolCall[];
}
/**
 * Tool call structure
 */
interface ToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}
/**
 * Tool definition
 */
interface ToolDefinition {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, any>;
    };
}
/**
 * Generation options
 */
interface GenerateOptions {
    model: string;
    messages: Message[];
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    stop?: string[];
    tools?: ToolDefinition[];
    toolChoice?: 'auto' | 'required' | 'none' | {
        type: 'function';
        function: {
            name: string;
        };
    };
    seed?: number;
}
/**
 * Generation result
 */
interface GenerateResult {
    text: string;
    finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error';
    usage: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
    toolCalls?: ToolCall[];
    rawResponse?: any;
}
/**
 * Stream chunk types
 */
type StreamChunkType = 'text-delta' | 'tool-call' | 'tool-result' | 'finish' | 'error';
/**
 * Stream chunk
 */
interface StreamChunk {
    type: StreamChunkType;
    textDelta?: string;
    toolCall?: ToolCall;
    toolResult?: {
        toolCallId: string;
        result: any;
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
 * Stream result
 */
interface StreamResult {
    textStream: AsyncIterable<string>;
    fullStream: AsyncIterable<StreamChunk>;
    text: Promise<string>;
    usage: Promise<{
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    }>;
    finishReason: Promise<string>;
    toolCalls: Promise<ToolCall[]>;
}
/**
 * LLM Provider interface
 */
interface LLMProvider {
    /**
     * Provider name (e.g., 'openai', 'anthropic', 'ollama')
     */
    readonly name: string;
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
 * LLM Provider configuration
 */
interface LLMProviderConfig {
    name: string;
    apiKey?: string;
    baseURL?: string;
    defaultModel?: string;
    timeout?: number;
    maxRetries?: number;
    headers?: Record<string, string>;
    [key: string]: any;
}
/**
 * Provider factory function type
 */
type ProviderFactory = (config: LLMProviderConfig) => LLMProvider;
/**
 * Provider registry
 */
declare class LLMProviderRegistry {
    private static providers;
    /**
     * Register a provider
     */
    static register(name: string, factory: ProviderFactory): void;
    /**
     * Create provider instance
     */
    static create(name: string, config: LLMProviderConfig): LLMProvider;
    /**
     * Check if provider is registered
     */
    static has(name: string): boolean;
    /**
     * Get all registered provider names
     */
    static getProviderNames(): string[];
    /**
     * Clear all providers (for testing)
     */
    static clear(): void;
}

/**
 * Flow Executor
 * Executes flow-based agents with full LLM and tool integration
 */

/**
 * Flow execution context
 */
interface FlowExecutionContext {
    agent: AgentConfig;
    session?: any;
    variables: Record<string, any>;
    provider: LLMProvider;
    toolRegistry?: ToolRegistry;
    memory?: any[];
    maxDepth?: number;
    currentDepth?: number;
}
/**
 * Flow execution event types
 */
type FlowExecutionEventType = 'flow-start' | 'flow-complete' | 'flow-error' | 'step-start' | 'step-complete' | 'step-error' | 'variable-set' | 'llm-call' | 'llm-response' | 'tool-call' | 'tool-result' | 'condition-evaluated' | 'loop-iteration';
/**
 * Flow execution event
 */
interface FlowExecutionEvent {
    type: FlowExecutionEventType;
    timestamp: Date;
    stepId?: string;
    stepType?: string;
    data?: any;
    variables?: Record<string, any>;
    error?: Error;
}
/**
 * Flow execution result
 */
interface FlowExecutionResult {
    success: boolean;
    output: any;
    variables: Record<string, any>;
    steps: number;
    events: FlowExecutionEvent[];
    error?: Error;
}
/**
 * Flow Executor
 */
declare class FlowExecutor {
    /**
     * Execute a flow
     */
    static execute(flow: AgentFlow, context: FlowExecutionContext, onEvent?: (event: FlowExecutionEvent) => void): Promise<FlowExecutionResult>;
    /**
     * Execute a single flow node
     */
    private static executeNode;
    /**
     * Execute sequence node
     */
    private static executeSequence;
    /**
     * Execute parallel node
     */
    private static executeParallel;
    /**
     * Execute oneOf (conditional) node
     */
    private static executeOneOf;
    /**
     * Execute forEach loop node
     */
    private static executeForEach;
    /**
     * Execute evaluator node
     */
    private static executeEvaluator;
    /**
     * Execute LLM call node
     */
    private static executeLLMCall;
    /**
     * Execute tool call node
     */
    private static executeToolCall;
    /**
     * Execute setVariable node
     */
    private static executeSetVariable;
    /**
     * Execute return node
     */
    private static executeReturn;
    /**
     * Execute end node
     */
    private static executeEnd;
    /**
     * Interpolate string with variables
     */
    private static interpolate;
    /**
     * Interpolate object with variables
     */
    private static interpolateObject;
    /**
     * Resolve a value (can be literal or variable reference)
     */
    private static resolveValue;
    /**
     * Evaluate a condition
     */
    private static evaluateCondition;
    /**
     * Evaluate an expression
     */
    private static evaluateExpression;
}

/**
 * Convert EditorStep to flows-ai compatible FlowDefinition
 * This recursively transforms the internal EditorStep structure
 * to the format expected by the flows-ai execution engine
 */
declare function convertToFlowDefinition(step: EditorStep): any;
/**
 * Convert flows-ai FlowDefinition back to EditorStep
 * Useful for round-tripping and editing
 */
declare function convertFromFlowDefinition(flowDef: any): EditorStep;

/**
 * Extract variable names from a string in the format @variableName
 * Returns array of variable names without the @ prefix
 */
declare function extractVariableNames(str: string): string[];
/**
 * Replace all occurrences of @variableName with actual values
 */
declare function replaceVariablesInString(str: string, variables: Record<string, string>): string;
/**
 * Inject variable values into a flow definition recursively
 */
declare function injectVariables(flowDef: any, variables: Record<string, string>): any;
/**
 * Apply transformation function to all input fields in flow definition
 */
declare function applyInputTransformation(flowDef: any, transformFn: (node: any) => Promise<any> | any): Promise<void>;
/**
 * Create a dynamic Zod schema from flow input variables
 */
declare function createDynamicZodSchemaForInputs(options: {
    availableInputs: FlowInputVariable[];
}): z.ZodObject<any>;
/**
 * Validate flow input against schema
 */
declare function validateFlowInput(input: any, variables: FlowInputVariable[]): {
    valid: boolean;
    errors: string[];
};
/**
 * Input type labels for UI display
 */
declare const INPUT_TYPE_LABELS: Record<FlowInputType, string>;

/**
 * Validate flow configuration
 */
declare function validateFlow(flow: Partial<AgentFlow>): {
    valid: boolean;
    errors: string[];
};
/**
 * Validate agent definition
 */
declare function validateAgentDefinition(agent: Partial<FlowAgentDefinition>): {
    valid: boolean;
    errors: string[];
};

export { FlowBuilder as F, type GenerateOptions as G, INPUT_TYPE_LABELS as I, type LLMProviderConfig as L, type Message as M, type ProviderFactory as P, type StreamResult as S, type ToolCall as T, type LLMProvider as a, type GenerateResult as b, type FlowExecutionContext as c, type FlowExecutionEventType as d, type FlowExecutionEvent as e, type FlowExecutionResult as f, FlowExecutor as g, convertToFlowDefinition as h, convertFromFlowDefinition as i, extractVariableNames as j, injectVariables as k, applyInputTransformation as l, createDynamicZodSchemaForInputs as m, validateFlow as n, validateAgentDefinition as o, type MessageRole as p, type ToolDefinition as q, replaceVariablesInString as r, type StreamChunkType as s, type StreamChunk as t, LLMProviderRegistry as u, validateFlowInput as v };
