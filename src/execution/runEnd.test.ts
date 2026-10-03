/**
 * LOU-Y4.2: `ExecuteOptions.onRunEnd` is called exactly once per run,
 * however the run ends.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { AgentExecutor, type ExecuteOptions } from './AgentExecutor';
import { InMemoryApprovalStore } from './InMemoryApprovalStore';
import { createAgent } from '../createAgent';
import { defineTool, type DefinedTool } from '../tools/defineTool';
import { ToolRegistry } from '../tools';
import { mockModel, type MockTurn } from '../testing';
import type { AgentConfig } from '../types';

const ping = defineTool({ name: 'ping', description: 'Ping', input: z.object({}), execute: () => 'pong' });
const gated = defineTool({ name: 'gated', description: 'Gated', input: z.object({}), needsApproval: true, execute: () => 'ok' });

function options(script: MockTurn[], tools: DefinedTool[] = [ping, gated]) {
  const toolRegistry = new ToolRegistry();
  toolRegistry.registerMany(tools);
  const agent: AgentConfig = { id: 'a', name: 'Agent', prompt: 'p', tools: Object.fromEntries(tools.map((t) => [t.name, { tool: t.name }])) };
  const onRunEnd = vi.fn<Parameters<NonNullable<ExecuteOptions['onRunEnd']>>, void | Promise<void>>();
  return { agent, provider: mockModel(script), toolRegistry, input: 'go', onRunEnd } satisfies ExecuteOptions;
}

describe('ExecuteOptions.onRunEnd (LOU-Y4.2)', () => {
  it('is called once with the result when the run finishes', async () => {
    const run = options(['hi']);
    const result = await AgentExecutor.execute(run);
    expect(run.onRunEnd).toHaveBeenCalledTimes(1);
    expect(run.onRunEnd).toHaveBeenCalledWith({ result });
  });

  it.each([
    ['aborted', (o: ExecuteOptions): ExecuteOptions => ({ ...o, signal: AbortSignal.abort() })],
    ['max-steps', (o: ExecuteOptions): ExecuteOptions => ({ ...o, maxSteps: 1 })],
    ['awaiting-approval', (o: ExecuteOptions): ExecuteOptions => ({ ...o, approvalStore: new InMemoryApprovalStore() })],
  ])('is called once when the run ends with %s', async (finishReason, configure) => {
    const run = options([{ toolCalls: [{ name: finishReason === 'awaiting-approval' ? 'gated' : 'ping' }] }, 'never']);
    const result = await AgentExecutor.execute(configure(run));
    expect(result.finishReason).toBe(finishReason);
    expect(run.onRunEnd).toHaveBeenCalledTimes(1);
    expect(run.onRunEnd).toHaveBeenCalledWith({ result });
  });

  it('is called once with the error when the run rejects', async () => {
    const run = options([{ error: new Error('provider down') }]);
    await expect(AgentExecutor.execute(run)).rejects.toThrow('provider down');
    expect(run.onRunEnd).toHaveBeenCalledTimes(1);
    expect(run.onRunEnd.mock.calls[0][0].error).toBeInstanceOf(Error);
  });

  it('is called with the error when the sub-agent catalog fails before the loop', async () => {
    const run = options(['hi']);
    const subagents = { list: () => Promise.reject(new Error('catalog down')), resolve: () => undefined };
    await expect(AgentExecutor.execute({ ...run, subagents })).rejects.toThrow('catalog down');
    expect(run.onRunEnd).toHaveBeenCalledTimes(1);
  });

  it('is called once per stream() run, also with sub-agents (no background task: no backgroundTasks)', async () => {
    const run = options(['hi']);
    const researcher = createAgent({ provider: mockModel([]), description: 'Researches' });
    const stream = AgentExecutor.stream({ ...run, subagents: { researcher } });
    for await (const event of stream) void event;
    const result = await stream.result;
    expect(run.onRunEnd).toHaveBeenCalledTimes(1);
    expect(run.onRunEnd).toHaveBeenCalledWith({ result });
    expect(result.backgroundTasks).toBeUndefined();
  });

  it('rejects the run when it throws', async () => {
    const run = { ...options(['hi']), onRunEnd: () => Promise.reject(new Error('cleanup failed')) };
    await expect(AgentExecutor.execute(run)).rejects.toThrow('cleanup failed');
  });
});
