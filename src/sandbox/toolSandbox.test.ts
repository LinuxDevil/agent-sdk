/**
 * defineTool({ sandbox }): the tool's execute crosses the boundary as
 * source, is called with cloned `[args, ctxSubset]`, and its span carries
 * `sandbox.driver` / `sandbox.error`. A fake driver evaluates the source
 * in-process, so no native `isolated-vm` is needed.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../tools/defineTool';
import { ToolRegistry } from '../tools/ToolRegistry';
import { AgentExecutor } from '../execution/AgentExecutor';
import { AgentBuilder } from '../core';
import { mockModel } from '../testing';
import type { Span, TraceExporter } from '../execution/tracing';
import { SandboxError } from './errors';
import type { SandboxDriver } from './types';
import type { ToolExecutionContext } from '../types';
import { SDKError } from '../utils/sdkError';

/** A driver that runs `code` (the tool's serialized execute) in-process with cloned args/result. */
function evalDriver(calls?: Array<{ code: string; args: unknown[] }>, name = 'fake'): SandboxDriver {
  return {
    name,
    async run(code, opts) {
      const args = (opts?.args ?? []).map((value) => structuredClone(value));
      calls?.push({ code, args });
      const fn = new Function(`return (${code})`)() as (...args: unknown[]) => unknown;
      return structuredClone(await fn(...args));
    },
  };
}

const input = z.object({ x: z.number() });

function ctx(partial: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return { toolCallId: 'call_1', messages: [], ...partial } as ToolExecutionContext;
}

describe('defineTool({ sandbox })', () => {
  it('runs execute inside the box with cloned args and the cloneable ctx subset', async () => {
    const calls: Array<{ code: string; args: unknown[] }> = [];
    const tool = defineTool({
      name: 'doubler',
      description: 'Double x',
      input,
      sandbox: { driver: evalDriver(calls) },
      execute: async (args, c) => ({ doubled: args.x * 2, callId: (c as { toolCallId?: string }).toolCallId }),
    });

    const arg = { x: 21 };
    const result = await tool.execute(arg, ctx({ sessionId: 's1' }));

    expect(result).toEqual({ doubled: 42, callId: 'call_1' });
    // The tool's own source crossed the boundary, not a wrapper.
    expect(calls[0].code).toContain('doubled');
    // The ctx subset carries toolCallId/sessionId and NOT the live members.
    const innerCtx = calls[0].args[1] as Record<string, unknown>;
    expect(innerCtx.toolCallId).toBe('call_1');
    expect(innerCtx.sessionId).toBe('s1');
    expect('abortSignal' in innerCtx).toBe(false);
    expect('getToken' in innerCtx).toBe(false);
    // The sandbox field on the descriptor marks it for the span attributes.
    expect(tool.sandbox).toEqual({ driver: expect.objectContaining({ name: 'fake' }) });
  });

  it('rejects with the SandboxError a boundary failure raised', async () => {
    const tool = defineTool({
      name: 'too_slow',
      description: 'Never returns',
      input,
      sandbox: { driver: { name: 'hang', run: () => new Promise(() => undefined) }, timeoutMs: 30 },
      execute: async () => ({ ok: true }),
    });

    await expect(tool.execute({ x: 1 }, ctx())).rejects.toMatchObject({ kind: 'timeout', toolErrorKind: 'sandbox' });
  });

  it("fails a sandboxed tool's own error as an ordinary tool error", async () => {
    const tool = defineTool({
      name: 'failing',
      description: 'Throws',
      input,
      sandbox: { driver: evalDriver() },
      execute: async () => {
        throw new RangeError('the tool failed');
      },
    });

    await expect(tool.execute({ x: 1 }, ctx())).rejects.toBeInstanceOf(RangeError);
  });

  it('rejects a reserved driver name at definition time', () => {
    expect(() =>
      defineTool({ name: 'boxed', description: 'x', input, sandbox: { driver: 'docker' }, execute: async () => ({}) })
    ).toThrowError(/not yet implemented/);
  });

  it('rejects sandbox combined with requiresSandbox/sandboxExecute or a generator execute', () => {
    expect(() =>
      defineTool({
        name: 'both',
        description: 'x',
        input,
        requiresSandbox: true,
        sandboxExecute: async () => ({}),
        sandbox: { driver: evalDriver() },
        execute: async () => ({}),
      })
    ).toThrowError(SDKError);
    expect(() =>
      defineTool({
        name: 'streamy',
        description: 'x',
        input,
        sandbox: { driver: evalDriver() },
        execute: async function* () {
          yield {};
        },
      })
    ).toThrowError(/generator/);
  });

  it('rejects a bound execute at definition time', () => {
    const bound = (async () => ({})).bind(null);
    expect(() => defineTool({ name: 'bound', description: 'x', input, sandbox: { driver: evalDriver() }, execute: bound })).toThrowError(
      /cannot be sandboxed/
    );
  });
});

/** In-memory exporter: remembers every span, in start order. */
function memoryExporter() {
  const spans: Span[] = [];
  const exporter: TraceExporter = {
    onSpanStart: (span) => spans.push(span),
    onSpanEnd: () => undefined,
  };
  return { exporter, spans };
}

async function runAgentWithTool(tool: ReturnType<typeof defineTool>) {
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(tool);
  const agent = {
    ...AgentBuilder.create().setName('Box Bot').addTool(tool.name, { tool: tool.name, options: {} }).build(),
    id: 'agent-1',
    prompt: 'You are terse.',
    settings: { model: 'test-model' },
  };
  const { exporter, spans } = memoryExporter();
  const provider = mockModel([
    { toolCalls: [{ id: 'call_1', name: tool.name, args: { x: 3 } }], usage: { inputTokens: 1, outputTokens: 1 } },
    { text: 'done', usage: { inputTokens: 1, outputTokens: 1 } },
  ]);
  await AgentExecutor.execute({ agent, input: 'go', provider, toolRegistry, exporter });
  return spans;
}

describe('sandboxed tool spans', () => {
  it('records sandbox.driver on the execute_tool span', async () => {
    const tool = defineTool({
      name: 'boxed_double',
      description: 'Double x',
      input,
      sandbox: { driver: evalDriver() },
      execute: async (args) => ({ doubled: (args as { x: number }).x * 2 }),
    });

    const spans = await runAgentWithTool(tool);

    const toolSpan = spans.find((span) => span.name === 'execute_tool boxed_double');
    expect(toolSpan?.attributes['sandbox.driver']).toBe('fake');
    expect(toolSpan?.attributes['sandbox.error']).toBeUndefined();
    expect(toolSpan?.status).toBeUndefined();
  });

  it('records sandbox.error when the boundary fails', async () => {
    const tool = defineTool({
      name: 'boxed_hang',
      description: 'Hangs',
      input,
      sandbox: {
        driver: { name: 'hang', run: () => Promise.reject(new SandboxError('out of memory', 'oom', 'hang')) },
      },
      execute: async () => ({ ok: true }),
    });

    const spans = await runAgentWithTool(tool);

    const toolSpan = spans.find((span) => span.name === 'execute_tool boxed_hang');
    expect(toolSpan?.attributes['sandbox.driver']).toBe('hang');
    expect(toolSpan?.attributes['sandbox.error']).toBe('oom');
    expect(toolSpan?.status?.code).toBe('error');
  });
});
