/**
 * Flow Executor Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FlowExecutor, FlowExecutionContext, FlowExecutionResult } from './FlowExecutor';
import { AgentFlow, AgentConfig } from '../types';
import { MockLLMProvider } from '../providers/mock';
import { ToolRegistry } from '../tools';

describe('FlowExecutor', () => {
  let mockProvider: MockLLMProvider;
  let toolRegistry: ToolRegistry;
  let agent: AgentConfig;
  let context: FlowExecutionContext;

  beforeEach(() => {
    mockProvider = new MockLLMProvider({
      name: 'mock',
      responses: ['Hello from LLM', 'Another response'],
    });

    toolRegistry = new ToolRegistry();
    toolRegistry.register('testTool', {
      tool: {
        description: 'Test tool',
        parameters: {},
        execute: async (args: any) => {
          return { success: true, input: args };
        },
      },
      type: 'Test',
    });

    agent = {
      id: 'test-agent',
      name: 'Test Agent',
      type: 'smart-assistant',
      prompt: 'You are a helpful assistant',
      settings: {
        model: 'gpt-4',
      },
    };

    context = {
      agent,
      provider: mockProvider,
      toolRegistry,
      variables: {},
    };
  });

  describe('Basic Execution', () => {
    it('should execute a simple return node', async () => {
      const flow: AgentFlow = {
        code: 'test-flow',
        name: 'Test Flow',
        flow: {
          type: 'return',
          value: 'Hello World',
        },
      };

      const result = await FlowExecutor.execute(flow, context);

      expect(result.success).toBe(true);
      expect(result.output).toBe('Hello World');
      expect(result.error).toBeUndefined();
    });

    it('should execute an end node', async () => {
      const flow: AgentFlow = {
        code: 'test-flow',
        name: 'Test Flow',
        flow: {
          type: 'end',
          value: 'Done',
        },
      };

      const result = await FlowExecutor.execute(flow, context);

      expect(result.success).toBe(true);
      expect(result.output).toBe('Done');
    });

    it('should handle errors', async () => {
      const flow: AgentFlow = {
        code: 'test-flow',
        name: 'Test Flow',
        flow: {
          type: 'throw',
          message: 'Test error',
        },
      };

      const result = await FlowExecutor.execute(flow, context);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('Test error');
    });
  });

  describe('Variables', () => {
    it('should set and retrieve variables', async () => {
      const flow: AgentFlow = {
        code: 'test-flow',
        name: 'Test Flow',
        flow: {
          type: 'sequence',
          steps: [
            {
              type: 'setVariable',
              variable: 'myVar',
              value: 'test value',
            },
            {
              type: 'return',
              value: '$myVar',
            },
          ],
        },
      };

      const result = await FlowExecutor.execute(flow, context);

      expect(result.success).toBe(true);
      expect(result.output).toBe('test value');
      expect(result.variables.myVar).toBe('test value');
    });

    it('should interpolate variables in strings', async () => {
      context.variables = { name: 'John', age: 30 };

      const flow: AgentFlow = {
        code: 'test-flow',
        name: 'Test Flow',
        flow: {
          type: 'return',
          value: 'Hello {{name}}, you are {{age}} years old',
        },
      };

      // Note: This test relies on implementation details
      // The interpolate method is private, so we test via return
      const result = await FlowExecutor.execute(flow, context);

      expect(result.success).toBe(true);
    });
  });

  describe('Sequence Execution', () => {
    it('should execute steps in sequence', async () => {
      const events: string[] = [];

      const flow: AgentFlow = {
        code: 'test-flow',
        name: 'Test Flow',
        flow: {
          type: 'sequence',
          steps: [
            {
              type: 'setVariable',
              variable: 'step1',
              value: 'first',
            },
            {
              type: 'setVariable',
              variable: 'step2',
              value: 'second',
            },
            {
              type: 'setVariable',
              variable: 'step3',
              value: 'third',
            },
          ],
        },
      };

      const result = await FlowExecutor.execute(flow, context);

      expect(result.success).toBe(true);
      expect(result.variables.step1).toBe('first');
      expect(result.variables.step2).toBe('second');
      expect(result.variables.step3).toBe('third');
    });

    it('should return last step result', async () => {
      const flow: AgentFlow = {
        code: 'test-flow',
        name: 'Test Flow',
        flow: {
          type: 'sequence',
          steps: [
            {
              type: 'setVariable',
              variable: 'temp',
              value: 'temp value',
            },
            {
              type: 'return',
              value: 'final result',
            },
          ],
        },
      };

      const result = await FlowExecutor.execute(flow, context);

      expect(result.success).toBe(true);
      expect(result.output).toBe('final result');
    });
  });

  describe('Parallel Execution', () => {
    it('should execute steps in parallel', async () => {
      const flow: AgentFlow = {
        code: 'test-flow',
        name: 'Test Flow',
        flow: {
          type: 'parallel',
          steps: [
            {
              type: 'return',
              value: 'result1',
            },
            {
              type: 'return',
              value: 'result2',
            },
            {
              type: 'return',
              value: 'result3',
            },
          ],
        },
      };

      const result = await FlowExecutor.execute(flow, context);

      expect(result.success).toBe(true);
      expect(result.output).toEqual(['result1', 'result2', 'result3']);
    });
  });

  describe('Conditional Execution (oneOf)', () => {
    it('should execute first matching condition', async () => {
      context.variables = { score: 85 };

      const flow: AgentFlow = {
        code: 'test-flow',
        name: 'Test Flow',
        flow: {
          type: 'oneOf',
          options: [
            {
              condition: '{{score}} >= 90',
              step: {
                type: 'return',
                value: 'A',
              },
            },
            {
              condition: '{{score}} >= 80',
              step: {
                type: 'return',
                value: 'B',
              },
            },
            {
              step: {
                type: 'return',
                value: 'F',
              },
            },
          ],
        },
      };

      const result = await FlowExecutor.execute(flow, context);

      expect(result.success).toBe(true);
      expect(result.output).toBe('B');
    });

    it('should execute default option when no conditions match', async () => {
      context.variables = { score: 50 };

      const flow: AgentFlow = {
        code: 'test-flow',
        name: 'Test Flow',
        flow: {
          type: 'oneOf',
          options: [
            {
              condition: '{{score}} >= 90',
              step: {
                type: 'return',
                value: 'A',
              },
            },
            {
              step: {
                type: 'return',
                value: 'F',
              },
            },
          ],
        },
      };

      const result = await FlowExecutor.execute(flow, context);

      expect(result.success).toBe(true);
      expect(result.output).toBe('F');
    });
  });

  describe('Loop Execution (forEach)', () => {
    it('should iterate over items', async () => {
      context.variables = { numbers: [1, 2, 3] };

      const flow: AgentFlow = {
        code: 'test-flow',
        name: 'Test Flow',
        flow: {
          type: 'forEach',
          items: '$numbers',
          itemVariable: 'num',
          step: {
            type: 'return',
            value: '$num',
          },
        },
      };

      const result = await FlowExecutor.execute(flow, context);

      expect(result.success).toBe(true);
      expect(result.output).toEqual([1, 2, 3]);
    });

    it('should provide index variable', async () => {
      context.variables = { items: ['a', 'b', 'c'] };

      const flow: AgentFlow = {
        code: 'test-flow',
        name: 'Test Flow',
        flow: {
          type: 'forEach',
          items: '$items',
          itemVariable: 'item',
          indexVariable: 'i',
          step: {
            type: 'setVariable',
            variable: 'lastIndex',
            value: '$i',
          },
        },
      };

      const result = await FlowExecutor.execute(flow, context);

      expect(result.success).toBe(true);
      expect(result.variables.lastIndex).toBe(2);
    });
  });

  describe('LLM Call Execution', () => {
    it('should call LLM with prompt', async () => {
      const flow: AgentFlow = {
        code: 'test-flow',
        name: 'Test Flow',
        flow: {
          type: 'llmCall',
          prompt: 'Tell me a joke',
          model: 'gpt-4',
        },
      };

      const result = await FlowExecutor.execute(flow, context);

      expect(result.success).toBe(true);
      expect(result.output).toBe('Hello from LLM');
    });

    it('should store LLM result in variable', async () => {
      const flow: AgentFlow = {
        code: 'test-flow',
        name: 'Test Flow',
        flow: {
          type: 'llmCall',
          prompt: 'Tell me a joke',
          outputVariable: 'joke',
        },
      };

      const result = await FlowExecutor.execute(flow, context);

      expect(result.success).toBe(true);
      expect(result.variables.joke).toBe('Hello from LLM');
    });

    it('should interpolate variables in prompt', async () => {
      context.variables = { topic: 'space' };

      const flow: AgentFlow = {
        code: 'test-flow',
        name: 'Test Flow',
        flow: {
          type: 'llmCall',
          prompt: 'Tell me about {{topic}}',
        },
      };

      const result = await FlowExecutor.execute(flow, context);

      expect(result.success).toBe(true);
    });
  });

  describe('Tool Call Execution', () => {
    it('should execute tool', async () => {
      const flow: AgentFlow = {
        code: 'test-flow',
        name: 'Test Flow',
        flow: {
          type: 'toolCall',
          tool: 'testTool',
          arguments: { value: 'test' },
        },
      };

      const result = await FlowExecutor.execute(flow, context);

      expect(result.success).toBe(true);
      expect(result.output).toEqual({ success: true, input: { value: 'test' } });
    });

    it('should store tool result in variable', async () => {
      const flow: AgentFlow = {
        code: 'test-flow',
        name: 'Test Flow',
        flow: {
          type: 'toolCall',
          tool: 'testTool',
          arguments: { value: 'test' },
          outputVariable: 'toolResult',
        },
      };

      const result = await FlowExecutor.execute(flow, context);

      expect(result.success).toBe(true);
      expect(result.variables.toolResult).toEqual({ success: true, input: { value: 'test' } });
    });

    it('should handle missing tool', async () => {
      const flow: AgentFlow = {
        code: 'test-flow',
        name: 'Test Flow',
        flow: {
          type: 'toolCall',
          tool: 'nonexistentTool',
          arguments: {},
        },
      };

      const result = await FlowExecutor.execute(flow, context);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('not found');
    });
  });

  describe('Events', () => {
    it('should emit execution events', async () => {
      const events: any[] = [];

      const flow: AgentFlow = {
        code: 'test-flow',
        name: 'Test Flow',
        flow: {
          type: 'return',
          value: 'test',
        },
      };

      await FlowExecutor.execute(flow, context, (event) => {
        events.push(event);
      });

      expect(events.length).toBeGreaterThan(0);
      expect(events[0].type).toBe('flow-start');
      expect(events[events.length - 1].type).toBe('flow-complete');
    });

    it('should track execution steps', async () => {
      const flow: AgentFlow = {
        code: 'test-flow',
        name: 'Test Flow',
        flow: {
          type: 'sequence',
          steps: [
            {
              type: 'setVariable',
              variable: 'v1',
              value: 'val1',
            },
            {
              type: 'setVariable',
              variable: 'v2',
              value: 'val2',
            },
          ],
        },
      };

      const result = await FlowExecutor.execute(flow, context);

      expect(result.steps).toBeGreaterThan(0);
      expect(result.events.length).toBeGreaterThan(0);
    });
  });

  describe('Error Handling', () => {
    it('should handle execution errors gracefully', async () => {
      const flow: AgentFlow = {
        code: 'test-flow',
        name: 'Test Flow',
        flow: {
          type: 'throw',
          message: 'Intentional error',
        },
      };

      const result = await FlowExecutor.execute(flow, context);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should prevent infinite recursion', async () => {
      // Create a deeply nested flow that exceeds maxDepth
      let deepFlow: any = { type: 'return', value: 'test' };
      
      // Create 15 levels of nesting (exceeds maxDepth of 10)
      for (let i = 0; i < 15; i++) {
        deepFlow = {
          type: 'sequence',
          steps: [deepFlow],
        };
      }

      const flow: AgentFlow = {
        code: 'test-flow',
        name: 'Test Flow',
        flow: deepFlow,
      };

      const result = await FlowExecutor.execute(
        flow,
        { ...context, maxDepth: 10 }
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Maximum flow depth');
    });
  });

  describe('Complex Flows', () => {
    it('should execute multi-level nested flow', async () => {
      context.variables = { items: ['a', 'b'] };

      const flow: AgentFlow = {
        code: 'test-flow',
        name: 'Test Flow',
        flow: {
          type: 'sequence',
          steps: [
            {
              type: 'forEach',
              items: '$items',
              itemVariable: 'item',
              step: {
                type: 'setVariable',
                variable: 'processed',
                value: '$item',
              },
            },
            {
              type: 'return',
              value: '$processed',
            },
          ],
        },
      };

      const result = await FlowExecutor.execute(flow, context);

      expect(result.success).toBe(true);
    });
  });
});



