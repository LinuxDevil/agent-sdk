import { CoreMessage } from 'ai';
import { a as ToolConfiguration } from './tool-DW-oM1Ru.mjs';

/**
 * Flow chunk event types
 */
declare enum FlowChunkType {
    FlowStart = "flowStart",
    FlowStepStart = "flowStepStart",
    FlowFinish = "flowFinish",
    Generation = "generation",
    GenerationEnd = "generationEnd",
    ToolCalls = "toolCalls",
    TextStream = "textStream",
    FinalResult = "finalResult",
    Error = "error",
    Message = "message",
    UIComponent = "uiComponent"
}
/**
 * Flow chunk event
 */
interface FlowChunkEvent {
    type: FlowChunkType;
    flowNodeId?: string;
    flowAgentId?: string;
    duration?: number;
    name?: string;
    timestamp?: Date;
    issues?: any[];
    result?: string | string[];
    message?: string;
    input?: any;
    toolResults?: Array<{
        args?: any;
        result?: string;
    }>;
    messages?: Array<{
        role: string;
        content: Array<{
            type: string;
            text: string;
        }>;
        id?: string;
    }>;
    component?: string;
    componentProps?: any;
    replaceFlowNodeId?: string;
    deleteFlowNodeId?: string;
}
/**
 * Flow input types
 */
type FlowInputType = 'shortText' | 'url' | 'longText' | 'number' | 'json' | 'fileBase64';
/**
 * Flow input variable
 */
interface FlowInputVariable {
    name: string;
    description?: string;
    required: boolean;
    type: FlowInputType;
}
/**
 * Tool setting for flows
 */
interface FlowToolSetting {
    name: string;
    options: any;
}
/**
 * Agent definition for flows
 */
interface FlowAgentDefinition {
    name: string;
    id?: string;
    model: string;
    system: string;
    tools: FlowToolSetting[];
}
/**
 * Agent flow definition
 */
interface AgentFlow {
    id?: string;
    code: string;
    name: string;
    description?: string;
    inputs?: FlowInputVariable[];
    flow?: EditorStep;
    agents?: FlowAgentDefinition[];
}
/**
 * Flow execution mode
 */
type FlowExecutionMode = 'sync' | 'async';
/**
 * Flow output mode
 */
type FlowOutputMode = 'stream' | 'buffer';
/**
 * Editor step types
 */
type EditorStep = StepNode | SequenceNode | ParallelNode | OneOfNode | ForEachNode | EvaluatorNode | BestOfAllNode | ToolNode | UIComponentNode | ConditionNode | LoopNode;
interface StepNode {
    type: 'step';
    agent: string;
    input: string;
}
interface SequenceNode {
    type: 'sequence';
    steps: EditorStep[];
}
interface ParallelNode {
    type: 'parallel';
    steps: EditorStep[];
}
interface OneOfNode {
    type: 'oneOf';
    branches: {
        when: string;
        flow: EditorStep;
    }[];
}
interface ForEachNode {
    type: 'forEach';
    item: string;
    inputFlow: EditorStep;
}
interface EvaluatorNode {
    type: 'evaluator';
    criteria: string;
    max_iterations?: number;
    subFlow: EditorStep;
}
interface BestOfAllNode {
    type: 'bestOfAll';
    criteria: string;
    steps: EditorStep[];
}
interface ToolNode {
    type: 'tool';
    toolName: string;
    toolOptions: Record<string, any>;
}
interface UIComponentNode {
    type: 'uiComponent';
    componentName: string;
    componentProps: Record<string, any>;
}
interface ConditionNode {
    type: 'condition';
    condition: string;
    trueFlow: EditorStep;
    falseFlow: EditorStep;
}
interface LoopNode {
    type: 'loop';
    maxIterations: number;
    condition: string;
    loopFlow: EditorStep;
}

/**
 * Agent type identifiers
 */
declare enum AgentType {
    SmartAssistant = "smart-assistant",
    SurveyAgent = "survey-agent",
    CommerceAgent = "commerce-agent",
    Flow = "flow"
}
/**
 * Agent type descriptor
 */
interface AgentTypeDescriptor {
    type: AgentType;
    description: Record<string, string>;
    requiredTabs: string[];
    supportsUserFacingUI: boolean;
    displayName: Record<string, string>;
}
/**
 * Agent configuration
 */
interface AgentConfig {
    id?: string;
    name: string;
    agentType: AgentType;
    locale?: string;
    prompt?: string;
    expectedResult?: any;
    tools?: Record<string, ToolConfiguration>;
    flows?: AgentFlow[];
    events?: any[];
    settings?: Record<string, any>;
    metadata?: Record<string, any>;
}
/**
 * Agent execution options
 */
interface AgentExecutionOptions {
    streaming?: boolean;
    sessionId: string;
    messages: CoreMessage[];
    attachments?: any[];
    locale?: string;
    timezone?: string;
    currentDateTime?: string;
}
/**
 * Agent execution result
 */
interface AgentExecutionResult {
    success: boolean;
    result?: any;
    error?: string;
    sessionId: string;
    tokensUsed?: number;
    duration?: number;
}
/**
 * Agent definition for flows
 */
interface AgentDefinition {
    name: string;
    id?: string;
    model: string;
    system: string;
    tools: ToolSetting[];
}
/**
 * Tool setting in agent definition
 */
interface ToolSetting {
    name: string;
    options: any;
}

export { type AgentTypeDescriptor as A, type BestOfAllNode as B, type ConditionNode as C, type EditorStep as E, FlowChunkType as F, type LoopNode as L, type OneOfNode as O, type ParallelNode as P, type StepNode as S, type ToolSetting as T, type UIComponentNode as U, AgentType as a, type AgentConfig as b, type AgentExecutionOptions as c, type AgentExecutionResult as d, type AgentDefinition as e, type FlowChunkEvent as f, type FlowInputType as g, type FlowInputVariable as h, type FlowToolSetting as i, type FlowAgentDefinition as j, type AgentFlow as k, type FlowExecutionMode as l, type FlowOutputMode as m, type SequenceNode as n, type ForEachNode as o, type EvaluatorNode as p, type ToolNode as q };
