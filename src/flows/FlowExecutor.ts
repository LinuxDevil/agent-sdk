/**
 * Flow Executor
 * Executes flow-based agents with full LLM and tool integration
 */

import { LLMProvider, Message } from '../providers';
import { ToolRegistry } from '../tools';
import { AgentFlow, EditorStep } from '../types';
import { AgentConfig } from '../types';
import { SandboxAdapter, NoopSandbox } from '../security/sandboxCore';
import { executeToolWithSandboxGuard } from '../execution/sandboxGuard';

/**
 * Flow execution context
 */
export interface FlowExecutionContext {
  agent: AgentConfig;
  session?: any;
  variables: Record<string, any>;
  provider: LLMProvider;
  toolRegistry?: ToolRegistry;
  memory?: any[];
  maxDepth?: number;
  currentDepth?: number;
  /**
   * SandboxAdapter used for tool-call nodes whose tool is flagged
   * `requiresSandbox` (LOU-F fix). Mirrors AgentExecutor's
   * `ExecuteOptions.sandbox` (LOU-F5): read per-call
   * (`context.sandbox ?? NoopSandbox`) rather than held as construction
   * state, since FlowExecutor is a static, instance-free API. Defaults to
   * NoopSandbox - the zero-isolation, trusted-host adapter - when omitted,
   * so existing callers see no behavior change.
   */
  sandbox?: SandboxAdapter;
}

/**
 * Flow execution event types
 */
export type FlowExecutionEventType =
  | 'flow-start'
  | 'flow-complete'
  | 'flow-error'
  | 'step-start'
  | 'step-complete'
  | 'step-error'
  | 'variable-set'
  | 'llm-call'
  | 'llm-response'
  | 'tool-call'
  | 'tool-result'
  | 'condition-evaluated'
  | 'loop-iteration';

/**
 * Flow execution event
 */
export interface FlowExecutionEvent {
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
export interface FlowExecutionResult {
  success: boolean;
  output: any;
  variables: Record<string, any>;
  steps: number;
  events: FlowExecutionEvent[];
  error?: Error;
}

/** Record an event and notify the optional listener. */
function emitEvent(
  events: FlowExecutionEvent[],
  onEvent: ((event: FlowExecutionEvent) => void) | undefined,
  event: FlowExecutionEvent
): void {
  events.push(event);
  onEvent?.(event);
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

type NodeHandler = (
  node: any,
  context: FlowExecutionContext,
  events: FlowExecutionEvent[],
  onEvent?: (event: FlowExecutionEvent) => void
) => any;

/**
 * Flow Executor
 */
export class FlowExecutor {
  /**
   * Execute a flow
   */
  static async execute(
    flow: AgentFlow,
    context: FlowExecutionContext,
    onEvent?: (event: FlowExecutionEvent) => void
  ): Promise<FlowExecutionResult> {
    const events: FlowExecutionEvent[] = [];
    const variables = { ...context.variables };

    // Emit flow start event
    emitEvent(events, onEvent, {
      type: 'flow-start',
      timestamp: new Date(),
      data: { flowCode: flow.code, flowName: flow.name },
    });

    try {
      // Execute the flow
      const output = await this.executeNode(
        flow.flow,
        { ...context, variables, currentDepth: 0 },
        events,
        onEvent
      );
      const steps = this.countCompletedSteps(events);

      // Emit flow complete event
      emitEvent(events, onEvent, {
        type: 'flow-complete',
        timestamp: new Date(),
        data: { output, steps },
        variables,
      });

      return {
        success: true,
        output,
        variables,
        steps,
        events,
      };
    } catch (error) {
      // Emit flow error event
      emitEvent(events, onEvent, {
        type: 'flow-error',
        timestamp: new Date(),
        error: error as Error,
      });

      return {
        success: false,
        output: null,
        variables,
        steps: this.countCompletedSteps(events),
        events,
        error: error as Error,
      };
    }
  }

  private static countCompletedSteps(events: FlowExecutionEvent[]): number {
    return events.filter(e => e.type === 'step-complete').length;
  }

  /**
   * Handler per node type. Handlers are looked up at call time so each one
   * dispatches through the class. Synchronous handlers return their value
   * directly (not a promise) so executeNode() doesn't add an extra await.
   */
  private static readonly nodeHandlers: ReadonlyMap<string, NodeHandler> = new Map<string, NodeHandler>([
    ['sequence', (node, context, events, onEvent) => this.executeSequence(node, context, events, onEvent)],
    ['parallel', (node, context, events, onEvent) => this.executeParallel(node, context, events, onEvent)],
    ['oneOf', (node, context, events, onEvent) => this.executeOneOf(node, context, events, onEvent)],
    ['forEach', (node, context, events, onEvent) => this.executeForEach(node, context, events, onEvent)],
    ['evaluator', (node, context, events, onEvent) => this.executeEvaluator(node, context, events, onEvent)],
    ['llmCall', (node, context, events, onEvent) => this.executeLLMCall(node, context, events, onEvent)],
    ['toolCall', (node, context, events, onEvent) => this.executeToolCall(node, context, events, onEvent)],
    ['setVariable', (node, context, events, onEvent) => this.executeSetVariable(node, context, events, onEvent)],
    ['return', (node, context) => this.executeReturn(node, context)],
    ['end', (node, context) => this.executeEnd(node, context)],
    [
      'throw',
      (node, context) => {
        throw new Error(this.interpolate((node as any).message || 'Flow error', context.variables));
      },
    ],
  ]);

  /**
   * Run the handler for a node's type; unknown types are rejected.
   */
  private static dispatchNode(
    node: any,
    context: FlowExecutionContext,
    events: FlowExecutionEvent[],
    onEvent?: (event: FlowExecutionEvent) => void
  ): any {
    const handler = this.nodeHandlers.get(node.type);
    if (!handler) {
      throw new Error(`Unknown node type: ${(node as any).type}`);
    }
    return handler(node, context, events, onEvent);
  }

  /**
   * Throw if the flow has recursed deeper than the context allows
   */
  private static assertWithinDepthLimit(context: FlowExecutionContext): void {
    // Check depth to prevent infinite recursion
    const maxDepth = context.maxDepth || 100;
    const currentDepth = context.currentDepth || 0;
    if (currentDepth > maxDepth) {
      throw new Error(`Maximum flow depth ${maxDepth} exceeded`);
    }
  }

  /**
   * Execute a single flow node
   */
  private static async executeNode(
    node: EditorStep | any,
    context: FlowExecutionContext,
    events: FlowExecutionEvent[],
    onEvent?: (event: FlowExecutionEvent) => void
  ): Promise<any> {
    this.assertWithinDepthLimit(context);

    const stepId = (node as any).id || `step-${Date.now()}`;

    // Emit step start event
    emitEvent(events, onEvent, {
      type: 'step-start',
      timestamp: new Date(),
      stepId,
      stepType: node.type,
    });

    try {
      const output = this.dispatchNode(node, context, events, onEvent);
      const result = output instanceof Promise ? await output : output;

      // Emit step complete event
      emitEvent(events, onEvent, {
        type: 'step-complete',
        timestamp: new Date(),
        stepId,
        stepType: node.type,
        data: result,
      });

      return result;
    } catch (error) {
      // Emit step error event
      emitEvent(events, onEvent, {
        type: 'step-error',
        timestamp: new Date(),
        stepId,
        stepType: node.type,
        error: error as Error,
      });

      throw error;
    }
  }

  /**
   * Context for a node nested one level below the given context
   */
  private static childContext(context: FlowExecutionContext): FlowExecutionContext {
    return { ...context, currentDepth: (context.currentDepth || 0) + 1 };
  }

  /**
   * Execute sequence node
   */
  private static async executeSequence(
    node: any,
    context: FlowExecutionContext,
    events: FlowExecutionEvent[],
    onEvent?: (event: FlowExecutionEvent) => void
  ): Promise<any> {
    const steps = node.steps || [];
    let lastResult: any = null;

    for (const step of steps) {
      lastResult = await this.executeNode(step, this.childContext(context), events, onEvent);
    }

    return lastResult;
  }

  /**
   * Execute parallel node
   */
  private static async executeParallel(
    node: any,
    context: FlowExecutionContext,
    events: FlowExecutionEvent[],
    onEvent?: (event: FlowExecutionEvent) => void
  ): Promise<any[]> {
    const steps = node.steps || [];

    const results = await Promise.all(
      steps.map((step: any) =>
        this.executeNode(step, this.childContext(context), events, onEvent)
      )
    );

    return results;
  }

  /**
   * Whether a oneOf option should run. An option with no condition is the default option.
   */
  private static optionApplies(
    option: any,
    context: FlowExecutionContext,
    events: FlowExecutionEvent[],
    onEvent?: (event: FlowExecutionEvent) => void
  ): boolean {
    return !option.condition || this.checkOptionCondition(option, context, events, onEvent);
  }

  /**
   * Evaluate a oneOf option's condition and emit the condition-evaluated event
   */
  private static checkOptionCondition(
    option: any,
    context: FlowExecutionContext,
    events: FlowExecutionEvent[],
    onEvent?: (event: FlowExecutionEvent) => void
  ): boolean {
    const conditionMet = this.evaluateCondition(option.condition, context.variables);

    // Emit condition evaluated event
    emitEvent(events, onEvent, {
      type: 'condition-evaluated',
      timestamp: new Date(),
      data: { condition: option.condition, result: conditionMet },
    });

    return conditionMet;
  }

  /**
   * Execute oneOf (conditional) node
   */
  private static async executeOneOf(
    node: any,
    context: FlowExecutionContext,
    events: FlowExecutionEvent[],
    onEvent?: (event: FlowExecutionEvent) => void
  ): Promise<any> {
    const option = this.selectOption(node, context, events, onEvent);

    return option ? await this.executeNode(option.step, this.childContext(context), events, onEvent) : null;
  }

  /**
   * First option whose condition holds (or that has none), if any
   */
  private static selectOption(
    node: any,
    context: FlowExecutionContext,
    events: FlowExecutionEvent[],
    onEvent?: (event: FlowExecutionEvent) => void
  ): any | undefined {
    const options = node.options || [];

    for (const option of options) {
      if (this.optionApplies(option, context, events, onEvent)) {
        return option;
      }
    }

    return undefined;
  }

  /**
   * Execute forEach loop node
   */
  private static async executeForEach(
    node: any,
    context: FlowExecutionContext,
    events: FlowExecutionEvent[],
    onEvent?: (event: FlowExecutionEvent) => void
  ): Promise<any[]> {
    const items = this.resolveValue(node.items, context.variables) || [];
    const { itemVar, indexVar } = this.loopVariableNames(node);
    const results: any[] = [];

    for (let i = 0; i < items.length; i++) {
      // Set loop variables in the current context
      context.variables[itemVar] = items[i];
      context.variables[indexVar] = i;

      // Emit loop iteration event
      emitEvent(events, onEvent, {
        type: 'loop-iteration',
        timestamp: new Date(),
        data: { item: items[i], index: i },
      });

      // Execute step with updated context
      if (node.step) {
        const result = await this.executeNode(node.step, this.childContext(context), events, onEvent);
        results.push(result);
      }
    }

    return results;
  }

  private static loopVariableNames(node: any): { itemVar: string; indexVar: string } {
    return {
      itemVar: node.itemVariable || 'item',
      indexVar: node.indexVariable || 'index',
    };
  }

  /**
   * Execute evaluator node
   */
  private static async executeEvaluator(
    node: any,
    context: FlowExecutionContext,
    _events: FlowExecutionEvent[],
    _onEvent?: (event: FlowExecutionEvent) => void
  ): Promise<any> {
    const expression = node.expression || '';
    return this.evaluateExpression(expression, context.variables);
  }

  /**
   * Store a node's result in its outputVariable, if it has one, and emit variable-set
   */
  private static storeOutputVariable(
    node: any,
    value: any,
    context: FlowExecutionContext,
    events: FlowExecutionEvent[],
    onEvent?: (event: FlowExecutionEvent) => void
  ): void {
    if (!node.outputVariable) {
      return;
    }

    context.variables[node.outputVariable] = value;

    emitEvent(events, onEvent, {
      type: 'variable-set',
      timestamp: new Date(),
      data: { variable: node.outputVariable, value },
    });
  }

  /**
   * Build the chat messages for an LLM call node
   */
  private static buildLLMMessages(context: FlowExecutionContext, prompt: string): Message[] {
    const messages: Message[] = [];

    // Add system prompt if available
    if (context.agent.prompt) {
      messages.push({
        role: 'system',
        content: context.agent.prompt,
      });
    }

    // Add user message
    messages.push({
      role: 'user',
      content: prompt,
    });

    return messages;
  }

  private static resolveLLMModel(
    node: any,
    context: FlowExecutionContext
  ): string | undefined {
    return node.model || context.agent.settings?.model || context.provider.defaultModel;
  }

  /**
   * Execute LLM call node
   */
  private static async executeLLMCall(
    node: any,
    context: FlowExecutionContext,
    events: FlowExecutionEvent[],
    onEvent?: (event: FlowExecutionEvent) => void
  ): Promise<string> {
    const prompt = this.interpolate(node.prompt || '', context.variables);
    const model = this.resolveLLMModel(node, context);
    const messages = this.buildLLMMessages(context, prompt);

    // Emit LLM call event
    emitEvent(events, onEvent, {
      type: 'llm-call',
      timestamp: new Date(),
      data: { model, prompt },
    });

    // Call LLM
    const result = await context.provider.generate({
      model,
      messages,
      temperature: node.temperature,
      maxTokens: node.maxTokens,
    });

    // Emit LLM response event
    emitEvent(events, onEvent, {
      type: 'llm-response',
      timestamp: new Date(),
      data: { text: result.text, usage: result.usage },
    });

    // Store result in variable if specified
    this.storeOutputVariable(node, result.text, context, events, onEvent);

    return result.text;
  }

  private static requireToolRegistry(context: FlowExecutionContext): ToolRegistry {
    if (!context.toolRegistry) {
      throw new Error('Tool registry not available');
    }
    return context.toolRegistry;
  }

  /**
   * Resolve the tool a toolCall node refers to, failing if it isn't available
   */
  private static lookupTool(
    node: any,
    context: FlowExecutionContext
  ): { toolName: string; toolDesc: NonNullable<ReturnType<ToolRegistry['get']>> } {
    const toolRegistry = this.requireToolRegistry(context);

    const toolName = node.tool || '';
    const toolDesc = toolRegistry.get(toolName);

    if (!toolDesc || !toolDesc.tool) {
      throw new Error(`Tool '${toolName}' not found`);
    }

    return { toolName, toolDesc };
  }

  /**
   * Execute tool call node
   */
  private static async executeToolCall(
    node: any,
    context: FlowExecutionContext,
    events: FlowExecutionEvent[],
    onEvent?: (event: FlowExecutionEvent) => void
  ): Promise<any> {
    const { toolName, toolDesc } = this.lookupTool(node, context);

    // Interpolate arguments
    const args = this.interpolateObject(node.arguments || {}, context.variables);

    // Emit tool call event
    emitEvent(events, onEvent, {
      type: 'tool-call',
      timestamp: new Date(),
      data: { tool: toolName, arguments: args },
    });

    // Execute tool. Tools flagged `requiresSandbox` are routed through the
    // configured SandboxAdapter instead of being invoked directly here -
    // mirrors AgentExecutor.executeToolCall()'s fail-closed handling
    // (LOU-F5) via the shared executeToolWithSandboxGuard() helper
    // (LOU-F fix), so this entry point can't silently bypass the sandbox
    // seam the way it previously did.
    const sandbox = context.sandbox ?? NoopSandbox;
    const result = await executeToolWithSandboxGuard(toolName, toolDesc, args, sandbox);

    // Emit tool result event
    emitEvent(events, onEvent, {
      type: 'tool-result',
      timestamp: new Date(),
      data: { tool: toolName, result },
    });

    // Store result in variable if specified
    this.storeOutputVariable(node, result, context, events, onEvent);

    return result;
  }

  /**
   * Execute setVariable node
   */
  private static async executeSetVariable(
    node: any,
    context: FlowExecutionContext,
    events: FlowExecutionEvent[],
    onEvent?: (event: FlowExecutionEvent) => void
  ): Promise<any> {
    const variableName = node.variable || '';
    const value = this.resolveValue(node.value, context.variables);

    context.variables[variableName] = value;

    emitEvent(events, onEvent, {
      type: 'variable-set',
      timestamp: new Date(),
      data: { variable: variableName, value },
    });

    return value;
  }

  /**
   * Execute return node
   */
  private static executeReturn(
    node: any,
    context: FlowExecutionContext
  ): any {
    return this.resolveValue(node.value, context.variables);
  }

  /**
   * Execute end node
   */
  private static executeEnd(
    node: any,
    context: FlowExecutionContext
  ): any {
    return this.resolveValue(node.value, context.variables);
  }

  /**
   * Interpolate string with variables
   */
  private static interpolate(template: string, variables: Record<string, any>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      return variables[key]?.toString() || '';
    });
  }

  /**
   * Interpolate object with variables
   */
  private static interpolateObject(obj: any, variables: Record<string, any>): any {
    if (typeof obj === 'string') {
      return this.interpolate(obj, variables);
    }
    if (Array.isArray(obj)) {
      return obj.map(item => this.interpolateObject(item, variables));
    }
    if (isObjectLike(obj)) {
      return this.interpolateRecord(obj, variables);
    }
    return obj;
  }

  private static interpolateRecord(obj: Record<string, unknown>, variables: Record<string, any>): any {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = this.interpolateObject(value, variables);
    }
    return result;
  }

  /**
   * Resolve a value (can be literal or variable reference)
   */
  private static resolveValue(value: any, variables: Record<string, any>): any {
    if (typeof value === 'string' && value.startsWith('$')) {
      const varName = value.substring(1);
      return variables[varName];
    }
    return value;
  }

  /**
   * Evaluate a condition
   */
  private static evaluateCondition(condition: string, variables: Record<string, any>): boolean {
    try {
      // Simple evaluation - supports basic comparisons
      // In production, use a safe expression evaluator
      const interpolated = this.interpolate(condition, variables);
      return !!eval(interpolated);
    } catch {
      return false;
    }
  }

  /**
   * Evaluate an expression
   */
  private static evaluateExpression(expression: string, variables: Record<string, any>): any {
    try {
      const interpolated = this.interpolate(expression, variables);
      return eval(interpolated);
    } catch (error) {
      throw new Error(`Failed to evaluate expression: ${expression}`);
    }
  }
}
