/**
 * Flow Executor
 * Executes flow-based agents with full LLM and tool integration
 */

import { LLMProvider, Message } from '../providers';
import { ToolRegistry } from '../tools';
import { AgentFlow, EditorStep } from '../types';
import { AgentConfig } from '../types';

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
    let steps = 0;

    // Emit flow start event
    const startEvent: FlowExecutionEvent = {
      type: 'flow-start',
      timestamp: new Date(),
      data: { flowCode: flow.code, flowName: flow.name },
    };
    events.push(startEvent);
    onEvent?.(startEvent);

    try {
      // Execute the flow
      const output = await this.executeNode(
        flow.flow,
        { ...context, variables, currentDepth: 0 },
        events,
        onEvent
      );
      steps = events.filter(e => e.type === 'step-complete').length;

      // Emit flow complete event
      const completeEvent: FlowExecutionEvent = {
        type: 'flow-complete',
        timestamp: new Date(),
        data: { output, steps },
        variables,
      };
      events.push(completeEvent);
      onEvent?.(completeEvent);

      return {
        success: true,
        output,
        variables,
        steps,
        events,
      };
    } catch (error) {
      // Emit flow error event
      const errorEvent: FlowExecutionEvent = {
        type: 'flow-error',
        timestamp: new Date(),
        error: error as Error,
      };
      events.push(errorEvent);
      onEvent?.(errorEvent);

      return {
        success: false,
        output: null,
        variables,
        steps: events.filter(e => e.type === 'step-complete').length,
        events,
        error: error as Error,
      };
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
    // Check depth to prevent infinite recursion
    const maxDepth = context.maxDepth || 100;
    const currentDepth = context.currentDepth || 0;
    if (currentDepth > maxDepth) {
      throw new Error(`Maximum flow depth ${maxDepth} exceeded`);
    }

    const stepId = (node as any).id || `step-${Date.now()}`;

    // Emit step start event
    const startEvent: FlowExecutionEvent = {
      type: 'step-start',
      timestamp: new Date(),
      stepId,
      stepType: node.type,
    };
    events.push(startEvent);
    onEvent?.(startEvent);

    try {
      let result: any;

      switch (node.type) {
        case 'sequence':
          result = await this.executeSequence(node, context, events, onEvent);
          break;
        case 'parallel':
          result = await this.executeParallel(node, context, events, onEvent);
          break;
        case 'oneOf':
          result = await this.executeOneOf(node, context, events, onEvent);
          break;
        case 'forEach':
          result = await this.executeForEach(node, context, events, onEvent);
          break;
        case 'evaluator':
          result = await this.executeEvaluator(node, context, events, onEvent);
          break;
        case 'llmCall':
          result = await this.executeLLMCall(node, context, events, onEvent);
          break;
        case 'toolCall':
          result = await this.executeToolCall(node, context, events, onEvent);
          break;
        case 'setVariable':
          result = await this.executeSetVariable(node, context, events, onEvent);
          break;
        case 'return':
          result = this.executeReturn(node, context);
          break;
        case 'end':
          result = this.executeEnd(node, context);
          break;
        case 'throw':
          throw new Error(this.interpolate((node as any).message || 'Flow error', context.variables));
        default:
          throw new Error(`Unknown node type: ${(node as any).type}`);
      }

      // Emit step complete event
      const completeEvent: FlowExecutionEvent = {
        type: 'step-complete',
        timestamp: new Date(),
        stepId,
        stepType: node.type,
        data: result,
      };
      events.push(completeEvent);
      onEvent?.(completeEvent);

      return result;
    } catch (error) {
      // Emit step error event
      const errorEvent: FlowExecutionEvent = {
        type: 'step-error',
        timestamp: new Date(),
        stepId,
        stepType: node.type,
        error: error as Error,
      };
      events.push(errorEvent);
      onEvent?.(errorEvent);

      throw error;
    }
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
      lastResult = await this.executeNode(
        step,
        { ...context, currentDepth: (context.currentDepth || 0) + 1 },
        events,
        onEvent
      );
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
        this.executeNode(
          step,
          { ...context, currentDepth: (context.currentDepth || 0) + 1 },
          events,
          onEvent
        )
      )
    );

    return results;
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
    const options = node.options || [];

    for (const option of options) {
      // Evaluate condition if present
      if (option.condition) {
        const conditionMet = this.evaluateCondition(option.condition, context.variables);
        
        // Emit condition evaluated event
        const conditionEvent: FlowExecutionEvent = {
          type: 'condition-evaluated',
          timestamp: new Date(),
          data: { condition: option.condition, result: conditionMet },
        };
        events.push(conditionEvent);
        onEvent?.(conditionEvent);

        if (conditionMet) {
          return await this.executeNode(
            option.step,
            { ...context, currentDepth: (context.currentDepth || 0) + 1 },
            events,
            onEvent
          );
        }
      } else {
        // Default option (no condition)
        return await this.executeNode(
          option.step,
          { ...context, currentDepth: (context.currentDepth || 0) + 1 },
          events,
          onEvent
        );
      }
    }

    return null;
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
    const itemVar = node.itemVariable || 'item';
    const indexVar = node.indexVariable || 'index';
    const results: any[] = [];

    for (let i = 0; i < items.length; i++) {
      // Set loop variables in the current context
      context.variables[itemVar] = items[i];
      context.variables[indexVar] = i;

      // Emit loop iteration event
      const iterationEvent: FlowExecutionEvent = {
        type: 'loop-iteration',
        timestamp: new Date(),
        data: { item: items[i], index: i },
      };
      events.push(iterationEvent);
      onEvent?.(iterationEvent);

      // Execute step with updated context
      if (node.step) {
        const result = await this.executeNode(
          node.step,
          { ...context, currentDepth: (context.currentDepth || 0) + 1 },
          events,
          onEvent
        );
        results.push(result);
      }
    }

    return results;
  }

  /**
   * Execute evaluator node
   */
  private static async executeEvaluator(
    node: any,
    context: FlowExecutionContext,
    events: FlowExecutionEvent[],
    onEvent?: (event: FlowExecutionEvent) => void
  ): Promise<any> {
    const expression = node.expression || '';
    return this.evaluateExpression(expression, context.variables);
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
    const model = node.model || context.agent.settings?.model || 'gpt-4';

    // Build messages
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

    // Emit LLM call event
    const callEvent: FlowExecutionEvent = {
      type: 'llm-call',
      timestamp: new Date(),
      data: { model, prompt },
    };
    events.push(callEvent);
    onEvent?.(callEvent);

    // Call LLM
    const result = await context.provider.generate({
      model,
      messages,
      temperature: node.temperature,
      maxTokens: node.maxTokens,
    });

    // Emit LLM response event
    const responseEvent: FlowExecutionEvent = {
      type: 'llm-response',
      timestamp: new Date(),
      data: { text: result.text, usage: result.usage },
    };
    events.push(responseEvent);
    onEvent?.(responseEvent);

    // Store result in variable if specified
    if (node.outputVariable) {
      context.variables[node.outputVariable] = result.text;
      
      const varEvent: FlowExecutionEvent = {
        type: 'variable-set',
        timestamp: new Date(),
        data: { variable: node.outputVariable, value: result.text },
      };
      events.push(varEvent);
      onEvent?.(varEvent);
    }

    return result.text;
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
    if (!context.toolRegistry) {
      throw new Error('Tool registry not available');
    }

    const toolName = node.tool || '';
    const toolDesc = context.toolRegistry.get(toolName);
    
    if (!toolDesc || !toolDesc.tool) {
      throw new Error(`Tool '${toolName}' not found`);
    }

    // Interpolate arguments
    const args = this.interpolateObject(node.arguments || {}, context.variables);

    // Emit tool call event
    const callEvent: FlowExecutionEvent = {
      type: 'tool-call',
      timestamp: new Date(),
      data: { tool: toolName, arguments: args },
    };
    events.push(callEvent);
    onEvent?.(callEvent);

    // Execute tool
    const result = toolDesc.tool.execute ? await toolDesc.tool.execute(args, {} as any) : null;

    // Emit tool result event
    const resultEvent: FlowExecutionEvent = {
      type: 'tool-result',
      timestamp: new Date(),
      data: { tool: toolName, result },
    };
    events.push(resultEvent);
    onEvent?.(resultEvent);

    // Store result in variable if specified
    if (node.outputVariable) {
      context.variables[node.outputVariable] = result;
      
      const varEvent: FlowExecutionEvent = {
        type: 'variable-set',
        timestamp: new Date(),
        data: { variable: node.outputVariable, value: result },
      };
      events.push(varEvent);
      onEvent?.(varEvent);
    }

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

    const varEvent: FlowExecutionEvent = {
      type: 'variable-set',
      timestamp: new Date(),
      data: { variable: variableName, value },
    };
    events.push(varEvent);
    onEvent?.(varEvent);

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
    if (obj && typeof obj === 'object') {
      const result: any = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.interpolateObject(value, variables);
      }
      return result;
    }
    return obj;
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
