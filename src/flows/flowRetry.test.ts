/**
 * Eve DUR-F17: per-node `retry` and `timeoutMs`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import type { AgentFlow, EditorStep } from '../types/flow';
import { FlowExecutor, type FlowExecutionContext, type FlowExecutionEvent } from './FlowExecutor';
import { MockLLMProvider } from '../providers/mock';
import { ToolRegistry } from '../tools';
import { memoryStore } from '../storage/agentStore';

function flowOf(root: EditorStep): AgentFlow {
  return { code: 'retry', name: 'Retry', flow: root };
}

describe('FlowExecutor node retry and timeout (DUR-F17)', () => {
  let toolRegistry: ToolRegistry;
  let context: FlowExecutionContext;
  let calls: number;
  let failures: number;
  let hangs: number;
  let sawAbort: boolean;

  beforeEach(() => {
    calls = 0;
    failures = 0;
    hangs = 0;
    sawAbort = false;
    toolRegistry = new ToolRegistry();
    toolRegistry.register('flaky', {
      displayName: 'Flaky',
      tool: {
        description: 'Fails `failures` times, hangs `hangs` times (until aborted), then succeeds',
        parameters: z.object({}),
        execute: async (_args: unknown, ctx?: { abortSignal?: AbortSignal }) => {
          calls++;
          if (hangs > 0) {
            hangs--;
            await new Promise((_, reject) =>
              ctx?.abortSignal?.addEventListener('abort', () => {
                sawAbort = true;
                reject(new Error('aborted'));
              })
            );
          }
          if (failures > 0) {
            failures--;
            throw new Error(`failure ${calls}`);
          }
          return `ok after ${calls}`;
        },
      },
    });
    context = {
      agent: { name: 'flow-agent' },
      provider: new MockLLMProvider({ name: 'mock', responses: ['hi'] }),
      toolRegistry,
      variables: {},
    };
  });

  it('retries a failing node with exponential backoff', async () => {
    failures = 2;
    const events: FlowExecutionEvent[] = [];
    const started = Date.now();
    const result = await FlowExecutor.execute(
      flowOf({ type: 'toolCall', tool: 'flaky', arguments: {}, retry: { maxAttempts: 3, backoffMs: 20 } }),
      context,
      (event) => events.push(event)
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe('ok after 3');
    const retries = events.filter((event) => event.type === 'step-retry');
    expect(retries.map((event) => event.data)).toEqual([
      { attempt: 1, maxAttempts: 3, delayMs: 20 },
      { attempt: 2, maxAttempts: 3, delayMs: 40 },
    ]);
    expect(retries[0].error?.message).toBe('failure 1');
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    expect(events.filter((event) => event.type === 'step-start')).toHaveLength(1);
  });

  it('fails with the last error once the attempts run out', async () => {
    failures = 5;
    const result = await FlowExecutor.execute(
      flowOf({ type: 'toolCall', tool: 'flaky', arguments: {}, retry: { maxAttempts: 2 } }),
      context
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('failure 2');
    expect(calls).toBe(2);
    expect(result.events.filter((event) => event.type === 'step-error')).toHaveLength(1);
  });

  it('fails an attempt past timeoutMs, aborting its tool call', async () => {
    hangs = 1;
    const result = await FlowExecutor.execute(flowOf({ type: 'toolCall', tool: 'flaky', arguments: {}, timeoutMs: 30 }), context);
    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'LOUSHO_OPERATION_TIMEOUT', timeoutMs: 30 });
    expect(sawAbort).toBe(true);
  });

  it('retries a timed-out attempt', async () => {
    hangs = 1;
    const result = await FlowExecutor.execute(
      flowOf({ type: 'toolCall', tool: 'flaky', arguments: {}, timeoutMs: 30, retry: { maxAttempts: 2 } }),
      context
    );
    expect(result).toMatchObject({ success: true, output: 'ok after 2' });
  });

  it('does not retry a cancelled run', async () => {
    failures = 5;
    const controller = new AbortController();
    toolRegistry.register('cancel', {
      displayName: 'Cancel',
      tool: {
        description: 'Cancels the run, then fails',
        parameters: z.object({}),
        execute: async () => {
          calls++;
          controller.abort(new Error('stop'));
          throw new Error('cancelled');
        },
      },
    });
    const result = await FlowExecutor.execute(
      flowOf({ type: 'toolCall', tool: 'cancel', arguments: {}, retry: { maxAttempts: 5 } }),
      { ...context, signal: controller.signal }
    );
    expect(result.success).toBe(false);
    expect(calls).toBe(1);
  });

  it('rejects invalid retry and timeout settings with LOUSHO_FLOW_INVALID', async () => {
    for (const bad of [{ retry: { maxAttempts: 0 } }, { retry: { maxAttempts: 2, backoffMs: -1 } }, { timeoutMs: 0 }]) {
      const result = await FlowExecutor.execute(flowOf({ type: 'return', value: 1, ...bad }), context);
      expect(result.error).toMatchObject({ code: 'LOUSHO_FLOW_INVALID' });
    }
  });

  it('in a durable run, a retried sequence does not repeat its completed children', async () => {
    let before = 0;
    toolRegistry.register('before', {
      displayName: 'Before',
      tool: { description: 'Counts', parameters: z.object({}), execute: async () => ++before },
    });
    failures = 1;
    const result = await FlowExecutor.execute(
      flowOf({
        type: 'sequence',
        retry: { maxAttempts: 2 },
        steps: [
          { type: 'toolCall', tool: 'before', arguments: {} },
          { type: 'toolCall', tool: 'flaky', arguments: {} },
        ],
      }),
      { ...context, checkpointStore: memoryStore().checkpoints, runId: 'r' }
    );
    expect(result).toMatchObject({ success: true, output: 'ok after 2' });
    expect(before).toBe(1);
  });
});
