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

/**
 * Eve DUR-F17: how `FlowExecutor` runs a node - retries and a time limit. Any
 * executor-side node (and `sequence` / `parallel`) takes them.
 *
 * @example
 * ```ts
 * const step: EditorStep = { type: 'toolCall', tool: 'fetch_invoice', retry: { maxAttempts: 3, backoffMs: 500 }, timeoutMs: 10_000 };
 * ```
 */
export interface NodeRunOptions {
  /**
   * Run the node again when it fails, up to `maxAttempts` times in all (an
   * integer >= 1), waiting `backoffMs * 2^(attempt - 1)` ms before each retry
   * (default 0). A cancelled run, or a run paused for approval, is not retried.
   */
  retry?: { maxAttempts: number; backoffMs?: number };
  /**
   * Fail an attempt that takes longer than this many ms with
   * `LOUSHO_OPERATION_TIMEOUT` (a timed-out attempt can be retried). The
   * attempt's model or tool call gets an aborted signal.
   */
  timeoutMs?: number;
}

export interface SequenceNode extends NodeRunOptions {
  type: 'sequence';
  steps: EditorStep[];
}

export interface ParallelNode extends NodeRunOptions {
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
export interface OneOfOptionsNode extends NodeRunOptions {
  type: 'oneOf';
  id?: string;
  options: OneOfOption[];
}

/** `forEach` as executed: `items` is a literal array or a `$variable` reference. */
export interface ForEachItemsNode extends NodeRunOptions {
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
export interface ExpressionEvaluatorNode extends NodeRunOptions {
  type: 'evaluator';
  id?: string;
  expression: string;
}

/** Calls the agent's provider with an interpolated prompt. */
export interface LLMCallNode extends NodeRunOptions {
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
export interface ToolCallNode extends NodeRunOptions {
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
export interface SetVariableNode extends NodeRunOptions {
  type: 'setVariable';
  id?: string;
  variable: string;
  value?: unknown;
}

/** Returns `value` (a string starting with `$` reads a variable). */
export interface ReturnNode extends NodeRunOptions {
  type: 'return';
  id?: string;
  value?: unknown;
}

/** Ends the flow with `value` (a string starting with `$` reads a variable). */
export interface EndNode extends NodeRunOptions {
  type: 'end';
  id?: string;
  value?: unknown;
}

/** Fails the flow with `message` (`{{var}}` placeholders are replaced). */
export interface ThrowNode extends NodeRunOptions {
  type: 'throw';
  id?: string;
  message?: string;
}
