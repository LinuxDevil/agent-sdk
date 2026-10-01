/**
 * Flow Executor Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FlowExecutor, FlowExecutionContext, FlowExecutionResult } from './FlowExecutor';
import { AgentFlow, AgentConfig } from '../types';
import { MockLLMProvider } from '../providers/mock';
import { ToolRegistry } from '../tools';
import { SandboxAdapter } from '../security/sandbox';

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

    it('binds {{vars}} as values: a hostile value cannot change the condition logic', async () => {
      context.variables = { input: "x' === 'x' || 'a" };

      const flow: AgentFlow = {
        code: 'test-flow',
        name: 'Test Flow',
        flow: {
          type: 'oneOf',
          options: [
            { condition: "'{{input}}' === 'admin'", step: { type: 'return', value: 'admin' } },
            { step: { type: 'return', value: 'guest' } },
          ],
        },
      };

      const result = await FlowExecutor.execute(flow, context);

      expect(result.output).toBe('guest');
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

  describe('Expression safety (no eval)', () => {
    const hostileFlow = (condition: string): AgentFlow => ({
      code: 'test-flow',
      name: 'Test Flow',
      flow: {
        type: 'oneOf',
        options: [
          { condition, step: { type: 'return', value: 'INJECTED' } },
          { step: { type: 'return', value: 'default' } },
        ],
      },
    });

    it.each([
      "process.exit(1)",
      "require('fs')",
      "constructor.constructor('return process')()",
      'globalThis',
      'score = 1',
    ])('treats %s as a failed condition instead of executing it', async (condition) => {
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      context.variables = { score: 85 };

      const result = await FlowExecutor.execute(hostileFlow(condition), context);

      expect(result.output).toBe('default');
      expect(exit).not.toHaveBeenCalled();
      expect(context.variables.score).toBe(85);
      exit.mockRestore();
    });

    it('still interpolates {{vars}} into conditions', async () => {
      context.variables = { classify: 'refund' };
      const result = await FlowExecutor.execute(hostileFlow("'{{classify}}' === 'refund'"), context);
      expect(result.output).toBe('INJECTED');
    });

    it('evaluator nodes compute safe expressions and fail the flow on unsupported syntax', async () => {
      context.variables = { a: 2, b: 3 };
      const ok = await FlowExecutor.execute(
        { code: 'f', name: 'F', flow: { type: 'evaluator', expression: 'a * b + 1' } } as AgentFlow,
        context
      );
      expect(ok.success).toBe(true);
      expect(ok.output).toBe(7);

      const bad = await FlowExecutor.execute(
        { code: 'f', name: 'F', flow: { type: 'evaluator', expression: "require('fs')" } } as AgentFlow,
        context
      );
      expect(bad.success).toBe(false);
      expect(bad.error?.message).toContain('Failed to evaluate expression: require');
      expect(bad.error?.message).toContain('position');
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

  describe('LOU-F fix: sandbox seam wiring in executeToolCall()', () => {
    it("routes a requiresSandbox:true tool with sandboxExecute() through the configured SandboxAdapter, never touching tool.execute()", async () => {
      const toolExecute = vi.fn().mockResolvedValue({ done: true });
      const sandboxExecute = vi.fn(async (args: unknown, sandbox: SandboxAdapter) => {
        await sandbox.writeFile('args.json', JSON.stringify(args));
        const runResult = await sandbox.run('echo', ['hello-from-real-work']);
        return { stdout: runResult.stdout };
      });

      toolRegistry.register('sandboxedFlowTool', {
        tool: {
          description: 'Sandboxed flow tool',
          parameters: {},
          execute: toolExecute,
        },
        type: 'Test',
        requiresSandbox: true,
        sandboxExecute,
      } as any);

      const spySandbox: SandboxAdapter = {
        name: 'spy',
        run: vi.fn().mockResolvedValue({ stdout: 'hello-from-real-work', stderr: '', exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
      };

      const flow: AgentFlow = {
        code: 'test-flow',
        name: 'Test Flow',
        flow: {
          type: 'toolCall',
          tool: 'sandboxedFlowTool',
          arguments: { value: 'test' },
        },
      };

      const result = await FlowExecutor.execute(flow, { ...context, sandbox: spySandbox });

      // sandboxExecute() itself was invoked, with the real (interpolated)
      // args and the configured sandbox adapter.
      expect(sandboxExecute).toHaveBeenCalledTimes(1);
      expect(sandboxExecute).toHaveBeenCalledWith({ value: 'test' }, spySandbox, expect.objectContaining({ toolCallId: expect.any(String), messages: [] }));
      expect(spySandbox.writeFile).toHaveBeenCalledWith(
        'args.json',
        JSON.stringify({ value: 'test' })
      );
      expect(spySandbox.run).toHaveBeenCalledWith('echo', ['hello-from-real-work']);

      // Critical assertion: the tool's own in-process execute() is NEVER
      // called for a genuinely-sandboxed tool invoked through a Flow.
      expect(toolExecute).not.toHaveBeenCalled();

      expect(result.success).toBe(true);
      expect(result.output).toEqual({ stdout: 'hello-from-real-work' });
    });

    it('a requiresSandbox:true tool with NO sandboxExecute() fails closed through a Flow - the run surfaces the error instead of silently running in-process', async () => {
      const toolExecute = vi.fn().mockResolvedValue({ done: true });

      toolRegistry.register('unsandboxableFlowTool', {
        tool: {
          description: 'Unsandboxable flow tool',
          parameters: {},
          execute: toolExecute,
        },
        type: 'Test',
        requiresSandbox: true,
        // no sandboxExecute implementation - this is the bug scenario
      } as any);

      const spySandbox: SandboxAdapter = {
        name: 'spy',
        run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
      };

      const flow: AgentFlow = {
        code: 'test-flow',
        name: 'Test Flow',
        flow: {
          type: 'toolCall',
          tool: 'unsandboxableFlowTool',
          arguments: {},
        },
      };

      const result = await FlowExecutor.execute(flow, { ...context, sandbox: spySandbox });

      // FlowExecutor's established convention for a thrown step error: the
      // flow result comes back with success:false and the error attached,
      // rather than a rejected promise (see 'should handle errors' above).
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('unsandboxableFlowTool');
      expect(result.error?.message).toContain('requiresSandbox');
      expect(result.error?.message).toContain('sandboxExecute');
      expect(result.error?.message).toContain('refusing to fall back to unsandboxed execution');

      // Fail-closed: neither the tool's real execute() NOR any real
      // sandbox operation happens. Before this fix, tool.execute() would
      // have run in-process on the host unconditionally, silently.
      expect(toolExecute).not.toHaveBeenCalled();
      expect(spySandbox.run).not.toHaveBeenCalled();
      expect(spySandbox.writeFile).not.toHaveBeenCalled();
    });

    it('a tool WITHOUT requiresSandbox through a flow behaves exactly as before (regression guard)', async () => {
      // Reuses the pre-existing 'testTool' registered in beforeEach, which
      // has no requiresSandbox flag - this is the same flow as the
      // "Tool Call Execution > should execute tool" test above.
      const spySandbox: SandboxAdapter = {
        name: 'spy',
        run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
        writeFile: vi.fn().mockResolvedValue(undefined),
      };

      const flow: AgentFlow = {
        code: 'test-flow',
        name: 'Test Flow',
        flow: {
          type: 'toolCall',
          tool: 'testTool',
          arguments: { value: 'test' },
        },
      };

      const result = await FlowExecutor.execute(flow, { ...context, sandbox: spySandbox });

      expect(result.success).toBe(true);
      expect(result.output).toEqual({ success: true, input: { value: 'test' } });
      expect(spySandbox.run).not.toHaveBeenCalled();
      expect(spySandbox.writeFile).not.toHaveBeenCalled();
    });
  });

  describe('LOU-D4: delegate tool compatibility', () => {
    it('produces the same event sequence as a built-in tool step', async () => {
      // Template: this mirrors "should execute tool" above (a single
      // toolCall step against a registered tool) exactly, except the tool
      // name points at a delegate tool created by createDelegateTool()
      // instead of a hand-rolled built-in-style tool. If delegate tools are
      // truly drop-in compatible with FlowExecutor's toolCall step, the two
      // flows should produce an identical sequence of event *types* (only
      // the event `data` payloads legitimately differ, since the tools do
      // different things).
      const { createDelegateTool } = await import('../execution/DelegationTool');
      const { AgentType } = await import('../types');

      const childProvider = new MockLLMProvider({
        name: 'mock-child',
        responses: ['delegated response'],
      });

      const childAgent = {
        name: 'Delegate Test Agent',
        agentType: AgentType.SmartAssistant,
        prompt: 'You are a test child agent',
      };

      toolRegistry.register(
        'delegate_test_agent',
        createDelegateTool({ agent: childAgent, provider: childProvider })
      );

      const builtinFlow: AgentFlow = {
        code: 'builtin-flow',
        name: 'Builtin Flow',
        flow: {
          type: 'toolCall',
          tool: 'testTool',
          arguments: { value: 'test' },
        },
      };

      const delegateFlow: AgentFlow = {
        code: 'delegate-flow',
        name: 'Delegate Flow',
        flow: {
          type: 'toolCall',
          tool: 'delegate_test_agent',
          arguments: { task: 'test' },
        },
      };

      const builtinEvents: any[] = [];
      const builtinResult = await FlowExecutor.execute(builtinFlow, context, (event) =>
        builtinEvents.push(event)
      );

      const delegateEvents: any[] = [];
      const delegateResult = await FlowExecutor.execute(delegateFlow, context, (event) =>
        delegateEvents.push(event)
      );

      expect(delegateResult.success).toBe(true);
      expect(builtinResult.success).toBe(true);
      expect(delegateEvents.map((e) => e.type)).toEqual(builtinEvents.map((e) => e.type));

      // Result shape: the delegate tool's own return value (text/usage) is
      // naturally different from the built-in test tool's return value,
      // but it is still a plain result object surfaced the same way a
      // built-in tool's result would be - no new FlowStep type or special
      // casing was needed in FlowExecutor for delegate tools to work.
      expect(delegateResult.output).toHaveProperty('text');
      expect(delegateResult.output).toHaveProperty('usage');
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



