/**
 * Flow Executor Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import type { ToolDescriptor } from '../types';
import type { EditorStep, AgentFlow } from '../types/flow';
import type { FlowExecutionEvent } from './FlowExecutor';
import { FlowExecutor, FlowExecutionContext } from './FlowExecutor';
import { AgentConfig } from '../types';
import { MockLLMProvider } from '../providers/mock';
import { ToolRegistry } from '../tools';
import { SandboxAdapter } from '../security/sandbox';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import { SDKError } from '../execution/errors';
import { defineTool } from '../tools/defineTool';
import { allow, ask, deny } from '../execution/permissions';

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
      displayName: 'Test tool',
      tool: {
        description: 'Test tool',
        parameters: z.object({ value: z.string().optional() }),
        execute: async (args: unknown) => {
          return { success: true, input: args };
        },
      },
    });

    agent = {
      id: 'test-agent',
      name: 'Test Agent',
      
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

  describe('A8: toolCall steps pass the agent gate', () => {
    const payFlow = (amount: string): AgentFlow => ({
      code: 'pay-flow',
      name: 'Pay flow',
      flow: { type: 'toolCall', tool: 'pay', arguments: { amount } },
    });

    function registerPay(needsApproval: ToolDescriptor['needsApproval'] = true) {
      const execute = vi.fn(async ({ amount }: { amount: string }) => `PAID ${amount}`);
      toolRegistry.register(defineTool({ name: 'pay', description: 'Pay a vendor', input: z.object({ amount: z.string() }), needsApproval, execute }));
      return execute;
    }

    it('refuses a needsApproval tool when the flow has no approve callback (fail closed)', async () => {
      const execute = registerPay();

      const result = await FlowExecutor.execute(payFlow('25000.00'), context);

      expect(result.success).toBe(false);
      expect(execute).not.toHaveBeenCalled();
      expect(result.error).toBeInstanceOf(SDKError);
      expect((result.error as SDKError).code).toBe('LOUSHO_FLOW_TOOL_DENIED');
      expect(result.error?.message).toContain("Tool 'pay' needs approval");
    });

    it('asks the approve callback, and runs the tool only when it approves', async () => {
      const execute = registerPay();
      const approve = vi.fn(({ args }: { args: Record<string, unknown> }) => Number(args.amount) < 1000);

      const small = await FlowExecutor.execute(payFlow('10.00'), { ...context, approve });
      const large = await FlowExecutor.execute(payFlow('25000.00'), { ...context, approve });

      expect(small.success).toBe(true);
      expect(small.output).toBe('PAID 10.00');
      expect(approve).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'pay', args: { amount: '10.00' }, toolCallId: expect.any(String) }));
      expect(large.success).toBe(false);
      expect((large.error as SDKError).code).toBe('LOUSHO_FLOW_TOOL_DENIED');
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("treats 'defer' as a refusal, since a flow cannot pause", async () => {
      const execute = registerPay();

      const result = await FlowExecutor.execute(payFlow('10.00'), { ...context, approve: () => 'defer' });

      expect((result.error as SDKError).code).toBe('LOUSHO_FLOW_TOOL_DENIED');
      expect(execute).not.toHaveBeenCalled();
    });

    it('applies permission rules: deny refuses, ask needs approve, allow skips needsApproval', async () => {
      const execute = registerPay();
      const onPermissionDecision = vi.fn();

      const denied = await FlowExecutor.execute(payFlow('1'), { ...context, approve: () => true, permissions: [deny('pay', 'No payments')], onPermissionDecision });
      expect((denied.error as SDKError).code).toBe('LOUSHO_FLOW_TOOL_DENIED');
      expect(denied.error?.message).toContain('No payments');
      expect(onPermissionDecision).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'pay', decision: 'deny' }), expect.anything());

      const asked = await FlowExecutor.execute(
        { code: 'echo', name: 'Echo', flow: { type: 'toolCall', tool: 'testTool', arguments: {} } },
        { ...context, permissions: [ask('testTool')] }
      );
      expect((asked.error as SDKError).code).toBe('LOUSHO_FLOW_TOOL_DENIED');

      const allowed = await FlowExecutor.execute(payFlow('2'), { ...context, permissions: [allow('pay')] });
      expect(allowed.success).toBe(true);
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("applies a needsApproval policy's deny", async () => {
      const execute = registerPay(() => ({ deny: 'Vendor is blocked' }));

      const result = await FlowExecutor.execute(payFlow('1'), { ...context, approve: () => true });

      expect((result.error as SDKError).code).toBe('LOUSHO_FLOW_TOOL_DENIED');
      expect(result.error?.message).toContain('Vendor is blocked');
      expect(execute).not.toHaveBeenCalled();
    });

    it('validates arguments against the tool schema before running it', async () => {
      const execute = vi.fn(async () => 'ran');
      toolRegistry.register(defineTool({ name: 'charge', description: 'Charge', input: z.object({ amount: z.number(), docId: z.string().min(1) }), execute }));

      const result = await FlowExecutor.execute(
        { code: 'charge', name: 'Charge', flow: { type: 'toolCall', tool: 'charge', arguments: { amount: '{{inv}}', docId: '{{missing}}' } } },
        { ...context, variables: { inv: { total: 1 } } }
      );

      expect(result.success).toBe(false);
      expect((result.error as SDKError).code).toBe('LOUSHO_TOOL_ARGS_INVALID');
      expect(result.error?.message).toContain('amount');
      expect(result.error?.message).toContain('docId');
      expect(execute).not.toHaveBeenCalled();
    });

    it('runs the tool with the schema-parsed arguments (defaults applied)', async () => {
      const execute = vi.fn(async (args: { currency: string }) => args);
      toolRegistry.register(defineTool({ name: 'quote', description: 'Quote', input: z.object({ currency: z.string().default('EUR') }), execute }));

      const result = await FlowExecutor.execute({ code: 'q', name: 'Q', flow: { type: 'toolCall', tool: 'quote', arguments: {} } }, context);

      expect(result.output).toEqual({ currency: 'EUR' });
    });
  });

  describe('A8: cancellation', () => {
    it('starts no further step once the signal is aborted, and fails with its reason', async () => {
      const controller = new AbortController();
      const ran: string[] = [];
      toolRegistry.register(defineTool({
        name: 'work',
        description: 'Work',
        input: z.object({ n: z.string() }),
        execute: async ({ n }) => {
          ran.push(n);
          if (n === '1') controller.abort(new Error('caller gave up'));
          return n;
        },
      }));
      const flow: AgentFlow = {
        code: 'slow',
        name: 'Slow',
        flow: { type: 'sequence', steps: ['1', '2', '3'].map((n) => ({ type: 'toolCall', tool: 'work', arguments: { n } })) },
      };

      const result = await FlowExecutor.execute(flow, { ...context, signal: controller.signal });

      expect(ran).toEqual(['1']);
      expect(result.success).toBe(false);
      expect(result.error?.message).toBe('caller gave up');
    });

    it('does not start at all with an already-aborted signal', async () => {
      const result = await FlowExecutor.execute(
        { code: 'r', name: 'R', flow: { type: 'return', value: 1 } },
        { ...context, signal: AbortSignal.abort() }
      );

      expect(result.success).toBe(false);
      expect(result.events.some((e) => e.type === 'step-start')).toBe(false);
    });

    it('hands the signal to tools as ctx.abortSignal and to the model request', async () => {
      const controller = new AbortController();
      let toolSignal: AbortSignal | undefined;
      toolRegistry.register(defineTool({ name: 'probe', description: 'Probe', input: z.object({}), execute: async (_args, ctx) => { toolSignal = ctx.abortSignal; return 'ok'; } }));
      const generate = vi.spyOn(mockProvider, 'generate');

      await FlowExecutor.execute(
        { code: 'p', name: 'P', flow: { type: 'sequence', steps: [{ type: 'toolCall', tool: 'probe', arguments: {} }, { type: 'llmCall', prompt: 'hi' }] } },
        { ...context, signal: controller.signal }
      );

      expect(toolSignal).toBe(controller.signal);
      expect(generate).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
    });
  });

  describe('A8: step ids', () => {
    it('gives every step without an id a unique id within the run', async () => {
      const flow: AgentFlow = {
        code: 'ids',
        name: 'Ids',
        flow: {
          type: 'sequence',
          steps: [
            { type: 'setVariable', variable: 'a', value: 1 },
            { type: 'parallel', steps: [{ type: 'setVariable', variable: 'b', value: 2 }, { type: 'setVariable', variable: 'c', value: 3 }] },
          ],
        },
      };

      const result = await FlowExecutor.execute(flow, context);
      const ids = result.events.filter((e) => e.type === 'step-start').map((e) => e.stepId);

      expect(ids).toHaveLength(5);
      expect(new Set(ids).size).toBe(5);
      expect(ids[0]).toBe('step-1');
    });
  });

  describe('A8: flow inputs', () => {
    const flowWithInput: AgentFlow = {
      code: 'needs-doc',
      name: 'Needs doc',
      inputs: [{ name: 'docId', type: 'shortText', required: true }],
      flow: { type: 'return', value: '$docId' },
    };

    it('fails the flow before any step when a required input is missing', async () => {
      const result = await FlowExecutor.execute(flowWithInput, context);

      expect(result.success).toBe(false);
      expect((result.error as SDKError).code).toBe('LOUSHO_VALIDATION_FAILED');
      expect(result.error?.message).toContain("Required input variable 'docId' is missing");
      expect(result.events.some((e) => e.type === 'step-start')).toBe(false);
    });

    it('fails the flow when an input has the wrong type', async () => {
      const result = await FlowExecutor.execute(flowWithInput, { ...context, variables: { docId: 42 } });

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain("Input variable 'docId' must be a string");
    });

    it('runs when the inputs are valid', async () => {
      const result = await FlowExecutor.execute(flowWithInput, { ...context, variables: { docId: 'inv-1' } });

      expect(result.success).toBe(true);
      expect(result.output).toBe('inv-1');
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
      } as Partial<ToolDescriptor> as ToolDescriptor);

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
      } as Partial<ToolDescriptor> as ToolDescriptor);

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

  describe('LOU-D4: defined tool compatibility', () => {
    it('produces the same event sequence as a built-in tool step', async () => {
      // Template: this mirrors "should execute tool" above (a single
      // toolCall step against a registered tool) exactly, except the tool
      // name points at a second defineTool() tool instead of the
      // hand-rolled built-in-style 'testTool'. If defined tools are truly
      // drop-in compatible with FlowExecutor's toolCall step, the two
      // flows should produce an identical sequence of event *types* (only
      // the event `data` payloads legitimately differ, since the tools do
      // different things).
      const { defineTool } = await import('../tools/defineTool');
      const { z } = await import('zod');

      toolRegistry.register(
        'delegate_test_agent',
        defineTool({
          name: 'delegate_test_agent',
          description: 'A second registered tool',
          input: z.object({ task: z.string() }),
          execute: async () => ({ text: 'delegated response' }),
        })
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

      const builtinEvents: FlowExecutionEvent[] = [];
      const builtinResult = await FlowExecutor.execute(builtinFlow, context, (event) =>
        builtinEvents.push(event)
      );

      const delegateEvents: FlowExecutionEvent[] = [];
      const delegateResult = await FlowExecutor.execute(delegateFlow, context, (event) =>
        delegateEvents.push(event)
      );

      expect(delegateResult.success).toBe(true);
      expect(builtinResult.success).toBe(true);
      expect(delegateEvents.map((e) => e.type)).toEqual(builtinEvents.map((e) => e.type));

      // Result shape: the second tool's own return value is naturally
      // different from the built-in test tool's return value, but it is
      // still a plain result object surfaced the same way a built-in
      // tool's result would be - no new FlowStep type or special casing
      // was needed in FlowExecutor for defined tools to work.
      expect(delegateResult.output).toEqual({ text: 'delegated response' });
    });
  });

  describe('Events', () => {
    it('should emit execution events', async () => {
      const events: FlowExecutionEvent[] = [];

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
      let deepFlow: EditorStep = { type: 'return', value: 'test' };
      
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

  describe('createAgent() agent rejection (LOU-R14)', () => {
    it('rejects a createAgent() agent with a coded error instead of silently dropping its instructions', async () => {
      const simpleAgent = createAgent({ provider: mockModel(['hi']) });
      const flow: AgentFlow = {
        code: 'test-flow',
        name: 'Test Flow',
        flow: {
          type: 'llmCall',
          prompt: 'Tell me a joke',
        },
      };

      await expect(
        FlowExecutor.execute(flow, { ...context, agent: simpleAgent as unknown as AgentConfig })
      ).rejects.toThrow(SDKError);
      await expect(
        FlowExecutor.execute(flow, { ...context, agent: simpleAgent as unknown as AgentConfig })
      ).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID' });
      await expect(
        FlowExecutor.execute(flow, { ...context, agent: simpleAgent as unknown as AgentConfig })
      ).rejects.toThrow('createAgent()');
    });

    it('still accepts a plain { name, prompt } agent config', async () => {
      const flow: AgentFlow = {
        code: 'test-flow',
        name: 'Test Flow',
        flow: {
          type: 'llmCall',
          prompt: 'Tell me a joke',
        },
      };

      const result = await FlowExecutor.execute(flow, context);

      expect(result.success).toBe(true);
      expect(result.output).toBe('Hello from LLM');
    });
  });
});

describe('FlowExecutor loop variable scoping (Eve DUR-F1)', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const flowOf = (root: EditorStep): AgentFlow => ({ code: 'f', name: 'f', flow: root });
  const chargeRegistry = () => {
    const charged: string[] = [];
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'charge',
      description: 'charge a customer',
      input: z.object({ customer: z.string() }),
      execute: async ({ customer }) => { await sleep(5); charged.push(customer); return 'ok'; },
    }));
    return { charged, registry };
  };
  const chargeEach = (items: string[]): EditorStep => ({
    type: 'forEach',
    items,
    step: { type: 'sequence', steps: [
      { type: 'llmCall', prompt: 'note for {{item}}' },
      { type: 'toolCall', tool: 'charge', arguments: { customer: '{{item}}' } },
    ] },
  } as EditorStep);

  it('gives each forEach iteration its own item, so parallel loops do not overwrite each other', async () => {
    const { charged, registry } = chargeRegistry();
    const provider = mockModel([{ text: 'note', delayMs: 3 }], { onExhausted: 'repeat-last' });
    const result = await FlowExecutor.execute(
      flowOf({ type: 'parallel', steps: [chargeEach(['alice', 'bob', 'carol']), chargeEach(['dave', 'erin', 'frank'])] } as EditorStep),
      { agent: { name: 'f', prompt: 'x' }, provider, toolRegistry: registry, variables: {} }
    );
    expect(result.success).toBe(true);
    expect([...charged].sort()).toEqual(['alice', 'bob', 'carol', 'dave', 'erin', 'frank']);
  });

  it('keeps loop variables local, lets other writes reach the flow, and shadows an outer variable of the same name', async () => {
    const result = await FlowExecutor.execute(
      flowOf({ type: 'sequence', steps: [
        { type: 'forEach', items: ['a', 'b'], step: { type: 'sequence', steps: [
          { type: 'setVariable', variable: 'last', value: '$item' },
          { type: 'evaluator', expression: '{{item}} + {{index}}' },
        ] } },
        { type: 'return', value: '$item' },
      ] } as EditorStep),
      { agent: { name: 'f' }, provider: mockModel(['x']), variables: { item: 'outer' } }
    );
    expect(result.success).toBe(true);
    expect(result.output).toBe('outer');
    expect(result.variables.last).toBe('b');
    expect(result.variables.index).toBeUndefined();
  });

  it('lets a nested loop read the outer loop variable in expressions and templates', async () => {
    const result = await FlowExecutor.execute(
      flowOf({ type: 'forEach', items: ['x', 'y'], itemVariable: 'outer', step: {
        type: 'forEach', items: [1, 2], itemVariable: 'inner', step: { type: 'evaluator', expression: '{{outer}} + {{inner}}' },
      } } as EditorStep),
      { agent: { name: 'f' }, provider: mockModel(['x']), variables: {} }
    );
    expect(result.success).toBe(true);
    expect(result.output).toEqual([['x1', 'x2'], ['y1', 'y2']]);
  });
});


