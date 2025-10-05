/**
 * Flow chunk event types
 */
export enum FlowChunkType {
  FlowStart = 'flowStart',
  FlowStepStart = 'flowStepStart',
  FlowFinish = 'flowFinish',
  Generation = 'generation',
  GenerationEnd = 'generationEnd',
  ToolCalls = 'toolCalls',
  TextStream = 'textStream',
  FinalResult = 'finalResult',
  Error = 'error',
  Message = 'message',
  UIComponent = 'uiComponent',
}

/**
 * Flow chunk event
 */
export interface FlowChunkEvent {
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
    content: Array<{ type: string; text: string }>;
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
export type FlowInputType =
  | 'shortText'
  | 'url'
  | 'longText'
  | 'number'
  | 'json'
  | 'fileBase64';

/**
 * Flow input variable
 */
export interface FlowInputVariable {
  name: string;
  description?: string;
  required: boolean;
  type: FlowInputType;
}

/**
 * Tool setting for flows
 */
export interface FlowToolSetting {
  name: string;
  options: any;
}

/**
 * Agent definition for flows
 */
export interface FlowAgentDefinition {
  name: string;
  id?: string;
  model: string;
  system: string;
  tools: FlowToolSetting[];
}

/**
 * Agent flow definition
 */
export interface AgentFlow {
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
export type FlowExecutionMode = 'sync' | 'async';

/**
 * Flow output mode
 */
export type FlowOutputMode = 'stream' | 'buffer';

/**
 * Editor step types
 */
export type EditorStep =
  | StepNode
  | SequenceNode
  | ParallelNode
  | OneOfNode
  | ForEachNode
  | EvaluatorNode
  | BestOfAllNode
  | ToolNode
  | UIComponentNode
  | ConditionNode
  | LoopNode;

export interface StepNode {
  type: 'step';
  agent: string;
  input: string;
}

export interface SequenceNode {
  type: 'sequence';
  steps: EditorStep[];
}

export interface ParallelNode {
  type: 'parallel';
  steps: EditorStep[];
}

export interface OneOfNode {
  type: 'oneOf';
  branches: {
    when: string;
    flow: EditorStep;
  }[];
}

export interface ForEachNode {
  type: 'forEach';
  item: string;
  inputFlow: EditorStep;
}

export interface EvaluatorNode {
  type: 'evaluator';
  criteria: string;
  max_iterations?: number;
  subFlow: EditorStep;
}

export interface BestOfAllNode {
  type: 'bestOfAll';
  criteria: string;
  steps: EditorStep[];
}

export interface ToolNode {
  type: 'tool';
  toolName: string;
  toolOptions: Record<string, any>;
}

export interface UIComponentNode {
  type: 'uiComponent';
  componentName: string;
  componentProps: Record<string, any>;
}

export interface ConditionNode {
  type: 'condition';
  condition: string;
  trueFlow: EditorStep;
  falseFlow: EditorStep;
}

export interface LoopNode {
  type: 'loop';
  maxIterations: number;
  condition: string;
  loopFlow: EditorStep;
}
