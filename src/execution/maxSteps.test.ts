/**
 * LOU-U19: exhausting `maxSteps` while the model still wants to continue
 * reports `finishReason: 'max-steps'` (on the result and on `run.done`).
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AgentExecutor } from './AgentExecutor';
import type { ApprovalStore, ExecutionSnapshot, PendingApproval } from './ApprovalGate';
import type { AgentEvent } from './agentEvents';
import { resumeAfterApproval } from './resume';
import { createAgent } from '../createAgent';
import { defineTool, DefinedTool } from '../tools/defineTool';
import { ToolRegistry } from '../tools';
import { mockModel, MockTurn } from '../testing';
import { AgentConfig } from '../types';

const ping = defineTool({
  name: 'ping',
  description: 'Ping',
  input: z.object({}),
  execute: async () => 'pong',
});

const gated = defineTool({
  name: 'gated',
  description: 'Needs approval',
  input: z.object({}),
  needsApproval: true,
  execute: async () => 'done',
});

function registryOf(tools: DefinedTool[]): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerMany(tools);
  return registry;
}

function options(tools: DefinedTool[], script: MockTurn[]) {
  const config: AgentConfig['tools'] = {};
  for (const t of tools) config[t.name] = { tool: t.name };
  const agent: AgentConfig = { id: 'a', name: 'Agent', prompt: 'p', tools: config };
  return { agent, provider: mockModel(script, { onExhausted: 'repeat-last' }), toolRegistry: registryOf(tools), input: 'go' };
}

function memoryApprovalStore(): ApprovalStore {
  const records = new Map<string, { pending: PendingApproval; snapshot: ExecutionSnapshot }>();
  return {
    async save(pending, snapshot) {
      records.set(pending.id, { pending, snapshot: JSON.parse(JSON.stringify(snapshot)) as ExecutionSnapshot });
    },
    async resolve(id) {
      const record = records.get(id) ?? null;
      records.delete(id);
      return record;
    },
  };
}

async function events(run: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const all: AgentEvent[] = [];
  for await (const event of run) all.push(event);
  return all;
}

const alwaysPing: MockTurn = { toolCalls: [{ name: 'ping', id: 'call_ping' }] };
const gatedCall: MockTurn = { toolCalls: [{ name: 'gated', id: 'call_gated' }] };

describe("finishReason 'max-steps'", () => {
  it('a model that always calls a tool exhausts maxSteps: 2', async () => {
    const result = await AgentExecutor.execute({ ...options([ping], [alwaysPing]), maxSteps: 2 });
    expect(result.finishReason).toBe('max-steps');
    expect(result.steps).toBe(2);
  });

  it('the finish event and run.done (AgentExecutor.stream) carry max-steps', async () => {
    const finishReasons: Array<string | undefined> = [];
    const run = AgentExecutor.stream({
      ...options([ping], [alwaysPing]),
      maxSteps: 2,
      onAgentEvent: (e) => {
        if (e.type === 'run.done') finishReasons.push(e.finishReason);
      },
    });
    const all = await events(run);
    expect(all.find((e) => e.type === 'run.done')).toMatchObject({ type: 'run.done', finishReason: 'max-steps' });
    expect((await run.result).finishReason).toBe('max-steps');
    expect(finishReasons).toEqual(['max-steps']);
  });

  it('agent.stream() run.done carries max-steps', async () => {
    const agent = createAgent({
      instructions: 'x',
      provider: mockModel([alwaysPing], { onExhausted: 'repeat-last' }),
      tools: [ping],
      maxSteps: 2,
    });
    const all = await events(agent.stream('go'));
    expect(all.find((e) => e.type === 'run.done')).toMatchObject({ finishReason: 'max-steps' });
  });

  it('a text reply on exactly the last allowed step is not max-steps', async () => {
    const result = await AgentExecutor.execute({ ...options([ping], [alwaysPing, 'all done']), maxSteps: 2 });
    expect(result.finishReason).toBe('stop');
    expect(result.steps).toBe(2);
    expect(result.text).toBe('all done');
  });

  it('a run that finishes well within the budget is unchanged', async () => {
    const result = await AgentExecutor.execute({ ...options([ping], ['hi']), maxSteps: 5 });
    expect(result.finishReason).toBe('stop');
  });

  it('initialSteps count against the budget', async () => {
    const result = await AgentExecutor.execute({ ...options([ping], [alwaysPing]), maxSteps: 3, initialSteps: 2 });
    expect(result.steps).toBe(3);
    expect(result.finishReason).toBe('max-steps');
  });

  it('a resume after approval that immediately exhausts the budget reports max-steps', async () => {
    const approvalStore = memoryApprovalStore();
    const paused = await AgentExecutor.execute({ ...options([gated], [gatedCall]), approvalStore, maxSteps: 1 });
    expect(paused.finishReason).toBe('awaiting-approval');

    const resumed = await resumeAfterApproval(
      { id: paused.approvalId!, approved: true },
      approvalStore,
      registryOf([gated]),
      mockModel(['never reached']),
      { maxSteps: 1 }
    );
    expect(resumed.finishReason).toBe('max-steps');
    expect(resumed.steps).toBe(1);
  });

  it('a resume after approval with budget left finishes naturally', async () => {
    const approvalStore = memoryApprovalStore();
    const paused = await AgentExecutor.execute({ ...options([gated], [gatedCall]), approvalStore, maxSteps: 2 });
    const resumed = await resumeAfterApproval(
      { id: paused.approvalId!, approved: true },
      approvalStore,
      registryOf([gated]),
      mockModel(['ok']),
      { maxSteps: 2 }
    );
    expect(resumed.finishReason).toBe('stop');
    expect(resumed.steps).toBe(2);
  });
});
