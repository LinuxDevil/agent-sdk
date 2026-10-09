/**
 * Eve DUR-F17: durable flow runs - checkpoint after each node, resume skips
 * the completed ones.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import type { AgentFlow, EditorStep } from '../types/flow';
import { FlowExecutor, type FlowExecutionContext } from './FlowExecutor';
import { MockLLMProvider } from '../providers/mock';
import { ToolRegistry } from '../tools';
import { memoryStore } from '../storage/agentStore';
import type { CheckpointStore } from '../execution/checkpoint';

function flowOf(root: EditorStep, code = 'durable'): AgentFlow {
  return { code, name: 'Durable', flow: root };
}

describe('FlowExecutor durability (DUR-F17)', () => {
  let provider: MockLLMProvider;
  let toolRegistry: ToolRegistry;
  let store: CheckpointStore;
  let flakyCalls: number;
  let failFlaky: boolean;
  let context: FlowExecutionContext;

  beforeEach(() => {
    provider = new MockLLMProvider({ name: 'mock', responses: ['one', 'two', 'three', 'four'] });
    vi.spyOn(provider, 'generate');
    toolRegistry = new ToolRegistry();
    flakyCalls = 0;
    failFlaky = true;
    toolRegistry.register('flaky', {
      displayName: 'Flaky',
      tool: {
        description: 'Fails while failFlaky is set',
        parameters: z.object({}),
        execute: async () => {
          flakyCalls++;
          if (failFlaky) throw new Error('service down');
          return 'ok';
        },
      },
    });
    store = memoryStore().checkpoints;
    context = {
      agent: { name: 'flow-agent' },
      provider,
      toolRegistry,
      variables: { topic: 'cats' },
      checkpointStore: store,
      runId: 'run-1',
    };
  });

  it('saves after each completed node and resume skips them', async () => {
    const flow = flowOf({
      type: 'sequence',
      steps: [
        { type: 'llmCall', prompt: 'about {{topic}}', outputVariable: 'first' },
        { type: 'toolCall', tool: 'flaky', arguments: {} },
        { type: 'llmCall', prompt: 'after {{first}}', outputVariable: 'second' },
      ],
    });

    const failed = await FlowExecutor.execute(flow, context);
    expect(failed.success).toBe(false);
    expect(provider.generate).toHaveBeenCalledTimes(1);

    const checkpoint = await store.load('run-1');
    expect(checkpoint?.status).toBe('in-progress');
    expect(checkpoint?.flow?.completedNodeIds).toEqual(['0.0']);
    expect(checkpoint?.flow?.variables).toEqual({ topic: 'cats', first: 'one' });
    expect(checkpoint?.flow?.usage.totalTokens).toBeGreaterThan(0);

    failFlaky = false;
    const { variables: _ignored, ...rest } = context;
    const resumed = await FlowExecutor.resume(flow, { ...rest, checkpointStore: store, runId: 'run-1' });

    expect(resumed.success).toBe(true);
    // The first llmCall is not repeated; the tool and the last llmCall run.
    expect(provider.generate).toHaveBeenCalledTimes(2);
    expect(flakyCalls).toBe(2);
    expect(resumed.output).toBe('two');
    expect(resumed.variables).toEqual({ topic: 'cats', first: 'one', second: 'two' });
    expect(resumed.steps).toBe(4); // llmCall, toolCall, llmCall, sequence
    expect(resumed.usage.totalTokens).toBe(failed.usage.totalTokens * 2);
    expect((await store.load('run-1'))?.status).toBe('finished');
  });

  it('takes the same oneOf branch on resume, even if the variables changed since', async () => {
    const flow = flowOf({
      type: 'sequence',
      steps: [
        {
          type: 'oneOf',
          options: [
            {
              condition: '{{mode}} === "a"',
              step: {
                type: 'sequence',
                steps: [
                  { type: 'setVariable', variable: 'mode', value: 'b' },
                  { type: 'toolCall', tool: 'flaky', arguments: {} },
                  { type: 'return', value: 'branch a' },
                ],
              },
            },
            { step: { type: 'return', value: 'default branch' } },
          ],
        },
      ],
    });

    const failed = await FlowExecutor.execute(flow, { ...context, variables: { mode: 'a' } });
    expect(failed.success).toBe(false);
    failFlaky = false;

    const resumed = await FlowExecutor.resume(flow, { ...context, checkpointStore: store, runId: 'run-1' });
    expect(resumed.output).toBe('branch a');
    expect(resumed.variables.mode).toBe('b');
  });

  it('skips completed forEach iterations and parallel branches', async () => {
    const seen: unknown[] = [];
    let failOn: string | undefined = 'z';
    toolRegistry.register('record', {
      displayName: 'Record',
      tool: {
        description: 'Records its value',
        parameters: z.object({ value: z.string() }),
        execute: async ({ value }: { value: string }) => {
          if (value === failOn) throw new Error(`no ${value}`);
          seen.push(value);
          return value;
        },
      },
    });
    const flow = flowOf({
      type: 'parallel',
      steps: [
        { type: 'forEach', items: ['x', 'y', 'z'], step: { type: 'toolCall', tool: 'record', arguments: { value: '{{item}}' } } },
        { type: 'setVariable', variable: 'other', value: 'done' },
      ],
    });

    expect((await FlowExecutor.execute(flow, context)).success).toBe(false);
    expect(seen).toEqual(['x', 'y']);
    expect((await store.load('run-1'))?.flow?.completedNodeIds).toEqual(['0.1', '0.0.0', '0.0.1']);
    failOn = undefined;

    const resumed = await FlowExecutor.resume(flow, { ...context, checkpointStore: store, runId: 'run-1' });
    expect(resumed.success).toBe(true);
    expect(resumed.output).toEqual([['x', 'y', 'z'], 'done']);
    // Only the failed iteration ran again.
    expect(seen).toEqual(['x', 'y', 'z']);
    expect((await store.load('run-1'))?.flow?.completedNodeIds).toEqual(['0']);
  });

  it('returns a finished run from its checkpoint without running it again', async () => {
    const flow = flowOf({ type: 'llmCall', prompt: 'hi' });
    const first = await FlowExecutor.execute(flow, context);
    expect(first.success).toBe(true);

    const again = await FlowExecutor.resume(flow, { ...context, checkpointStore: store, runId: 'run-1' });
    expect(again).toMatchObject({ success: true, output: 'one', steps: 1, events: [] });
    expect(provider.generate).toHaveBeenCalledTimes(1);

    // A finished run id can be executed again, as a new run.
    expect((await FlowExecutor.execute(flow, context)).output).toBe('two');
  });

  it('refuses to restart an unfinished run with execute()', async () => {
    const flow = flowOf({ type: 'sequence', steps: [{ type: 'return', value: 1 }, { type: 'toolCall', tool: 'flaky', arguments: {} }] });
    await FlowExecutor.execute(flow, context);

    await expect(FlowExecutor.execute(flow, context)).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID' });
  });

  it('rejects a resume without a checkpoint, of another flow, or without a store', async () => {
    const flow = flowOf({ type: 'sequence', steps: [{ type: 'return', value: 1 }, { type: 'toolCall', tool: 'flaky', arguments: {} }] });
    await expect(FlowExecutor.resume(flow, { ...context, checkpointStore: store, runId: 'nope' })).rejects.toMatchObject({
      code: 'LOUSHO_CHECKPOINT_NOT_FOUND',
    });

    await FlowExecutor.execute(flow, context);
    await expect(
      FlowExecutor.resume(flowOf(flow.flow as EditorStep, 'other'), { ...context, checkpointStore: store, runId: 'run-1' })
    ).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID' });

    await expect(FlowExecutor.execute(flow, { ...context, checkpointStore: undefined })).rejects.toMatchObject({
      code: 'LOUSHO_CONFIG_INVALID',
    });
  });

  it('leaves a run without checkpointStore/runId unchanged', async () => {
    const { checkpointStore: _s, runId: _r, ...plain } = context;
    const result = await FlowExecutor.execute(flowOf({ type: 'return', value: 'v' }), plain);
    expect(result).toMatchObject({ success: true, output: 'v' });
  });
});
