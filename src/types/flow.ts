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
  issues?: unknown[];
  result?: string | string[];
  message?: string;
  input?: unknown;
  toolResults?: Array<{
    args?: unknown;
    result?: string;
  }>;
  messages?: Array<{
    role: string;
    content: Array<{ type: string; text: string }>;
    id?: string;
  }>;
  component?: string;
  componentProps?: Record<string, unknown>;
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
  options: unknown;
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
 * A flow node: every shape `FlowExecutor` can run, discriminated on `type`.
 *
 * The first group are the editor-side shapes; the second group are the executor-side shapes the
 * handler map in `FlowExecutor` reads. `oneOf`, `forEach` and `evaluator`
 * appear in both groups with different fields: `oneOf` has `branches`
 * (editor) or `options` (executor), and so on, so narrow on those fields too.
 *
 * @example
 * ```ts
 * const steps: EditorStep = {
 *   type: 'sequence',
 *   steps: [
 *     { type: 'llmCall', prompt: 'Classify: {{message}}', outputVariable: 'category' },
 *     {
 *       type: 'oneOf',
 *       options: [
 *         { condition: "'{{category}}' === 'billing'", step: { type: 'return', value: 'billing' } },
 *         { step: { type: 'return', value: 'other' } },
 *       ],
 *     },
 *   ],
 * };
 * ```
 */
export type EditorStep = EditorShapeStep | RuntimeStep;

/** Editor-side node shapes (what visual editors produce). */
export type EditorShapeStep =
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

/** Executor-side node shapes, with the fields `FlowExecutor`'s handlers read. */
export type RuntimeStep =
  | OneOfOptionsNode
  | ForEachItemsNode
  | ExpressionEvaluatorNode
  | LLMCallNode
  | ToolCallNode
  | SetVariableNode
  | ReturnNode
  | EndNode
  | ThrowNode;

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
  toolOptions: Record<string, unknown>;
}

export interface UIComponentNode {
  type: 'uiComponent';
  componentName: string;
  componentProps: Record<string, unknown>;
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

/** One option of a {@link OneOfOptionsNode}. No `condition` means "default". */
export interface OneOfOption {
  /** Expression with `{{var}}` placeholders; see "Flow expressions" in the docs. */
  condition?: string;
  step: EditorStep;
}

/** `oneOf` as executed: runs the first option whose condition holds. */
export interface OneOfOptionsNode {
  type: 'oneOf';
  id?: string;
  options: OneOfOption[];
}

/** `forEach` as executed: `items` is a literal array or a `$variable` reference. */
export interface ForEachItemsNode {
  type: 'forEach';
  id?: string;
  items: unknown[] | string;
  /** Variable holding the current item (default `item`). */
  itemVariable?: string;
  /** Variable holding the current index (default `index`). */
  indexVariable?: string;
  step?: EditorStep;
}

/** `evaluator` as executed: evaluates `expression` and returns the result. */
export interface ExpressionEvaluatorNode {
  type: 'evaluator';
  id?: string;
  expression: string;
}

/** Calls the agent's provider with an interpolated prompt. */
export interface LLMCallNode {
  type: 'llmCall';
  id?: string;
  /** Prompt template; `{{var}}` placeholders are replaced by variable text. */
  prompt?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Variable that receives the response text. */
  outputVariable?: string;
}

/** Calls a registered tool by name. */
export interface ToolCallNode {
  type: 'toolCall';
  id?: string;
  /** Name of the tool in the ToolRegistry. */
  tool: string;
  /** Arguments; strings (at any depth) have `{{var}}` placeholders replaced. */
  arguments?: Record<string, unknown>;
  /** Variable that receives the tool result. */
  outputVariable?: string;
}

/** Sets a flow variable; a `value` string starting with `$` reads another variable. */
export interface SetVariableNode {
  type: 'setVariable';
  id?: string;
  variable: string;
  value?: unknown;
}

/** Returns `value` (a string starting with `$` reads a variable). */
export interface ReturnNode {
  type: 'return';
  id?: string;
  value?: unknown;
}

/** Ends the flow with `value` (a string starting with `$` reads a variable). */
export interface EndNode {
  type: 'end';
  id?: string;
  value?: unknown;
}

/** Fails the flow with `message` (`{{var}}` placeholders are replaced). */
export interface ThrowNode {
  type: 'throw';
  id?: string;
  message?: string;
}
