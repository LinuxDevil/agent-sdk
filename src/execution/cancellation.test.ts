/**
 * LOU-V1: cancelling a run with an AbortSignal.
 *
 * Covers the executor loop (abort before start, during a model call, during
 * a tool call, between steps), checkpoint-on-abort + resume, the "an abort is
 * not a failure" rules (no retry, no failure compaction), delegated child
 * agents, createAgent().send() and resumeAfterApproval().
 */

import { describe, it, expect, vi } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { AgentExecutor, ExecutionEvent } from './AgentExecutor';
import { createDelegateTool } from './DelegationTool';
import type { ApprovalStore, ExecutionSnapshot, PendingApproval } from './ApprovalGate';
import { resumeAfterApproval } from './resume';
import { retry } from './retry';
import { Checkpoint, CheckpointStore } from './checkpoint';
import { createMockProvider } from '../providers/mock';
import { createAgent } from '../createAgent';
import { ToolRegistry } from '../tools';
import { AgentConfig, AgentType, ToolDescriptor } from '../types';
import type { GenerateOptions, GenerateResult, LLMProvider, ToolCall } from '../providers';

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

function textResult(text: string): GenerateResult {
  return { text, finishReason: 'stop', usage };
}

function toolCall(name: string, id = `call_${name}`): ToolCall {
  return { id, type: 'function', function: { name, arguments: '{}' } };
}

function toolCallResult(...calls: ToolCall[]): GenerateResult {
  return { text: '', finishReason: 'tool_calls', usage, toolCalls: calls };
}

function scriptedProvider(generate: (options: GenerateOptions) => Promise<GenerateResult>) {
  const spy = vi.fn(generate);
  const provider: LLMProvider = {
    name: 'scripted',
    generate: spy,
    stream: vi.fn() as never,
    supportsTools: () => true,
    supportsStreaming: () => true,
    getModels: async () => [],
  };
  return { provider, generate: spy };
}

/** A generate() that never settles on its own - it only rejects once aborted. */
function hangUntilAborted(options: GenerateOptions): Promise<GenerateResult> {
  return new Promise((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
  });
}

function agentWithTools(...toolNames: string[]): AgentConfig {
  const tools: AgentConfig['tools'] = {};
  for (const name of toolNames) {
    tools[name] = { tool: name };
  }
  return { id: 'agent-1', name: 'Agent', agentType: AgentType.SmartAssistant, prompt: 'p', tools };
}

function registryWith(tools: Record<string, ToolDescriptor>): ToolRegistry {
  const registry = new ToolRegistry();
  for (const [name, descriptor] of Object.entries(tools)) {
    registry.register(name, descriptor);
  }
  return registry;
}

function simpleTool(
  execute: (args: Record<string, never>, options: { abortSignal?: AbortSignal }) => Promise<unknown>,
  extra: Partial<ToolDescriptor> = {}
): ToolDescriptor {
  return {
    displayName: 'Test tool',
    tool: tool({ description: 'test tool', parameters: z.object({}), execute }),
    ...extra,
  };
}

function createInMemoryCheckpointStore(): CheckpointStore & { checkpoints: Map<string, Checkpoint> } {
  const checkpoints = new Map<string, Checkpoint>();
  return {
    checkpoints,
    async save(sessionId, checkpoint) {
      checkpoints.set(sessionId, checkpoint);
    },
    async load(sessionId) {
      return checkpoints.get(sessionId) ?? null;
    },
    async delete(sessionId) {
      checkpoints.delete(sessionId);
    },
  };
}

function createApprovalStore(): ApprovalStore {
  const records = new Map<string, { pending: PendingApproval; snapshot: ExecutionSnapshot }>();
  return {
    save: async (pending, snapshot) => void records.set(pending.id, { pending, snapshot }),
    resolve: async (id) => records.get(id) ?? null,
  };
}

describe('AgentExecutor cancellation (LOU-V1)', () => {
  it('an already-aborted signal resolves immediately with finishReason "aborted" and never calls the provider', async () => {
    const { provider, generate } = scriptedProvider(async () => textResult('never'));
    const events: ExecutionEvent[] = [];
    const controller = new AbortController();
    controller.abort();

    const result = await AgentExecutor.execute({
      agent: agentWithTools(),
      input: 'hi',
      provider,
      signal: controller.signal,
      onEvent: (event) => events.push(event),
    });

    expect(generate).not.toHaveBeenCalled();
    expect(result.finishReason).toBe('aborted');
    expect(result.steps).toBe(0);
    expect(result.messages.map((m) => m.role)).toEqual(['system', 'user']);
    const abortEvent = events.find((e) => e.type === 'abort');
    expect(abortEvent).toBeDefined();
    expect(abortEvent?.abortReason).toBe(controller.signal.reason);
    expect(events.at(-1)).toMatchObject({ type: 'finish', finishReason: 'aborted' });
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('aborting during a model call resolves (does not reject) with the partial transcript', async () => {
    const { provider, generate } = scriptedProvider(hangUntilAborted);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const result = await AgentExecutor.execute({
      agent: agentWithTools(),
      input: 'hi',
      provider,
      signal: controller.signal,
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][0].signal).toBe(controller.signal);
    expect(result.finishReason).toBe('aborted');
    expect(result.messages.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('the mock provider honors the signal mid-delay', async () => {
    const provider = createMockProvider({ name: 'mock', delay: 60_000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const started = Date.now();

    const result = await AgentExecutor.execute({
      agent: agentWithTools(),
      input: 'hi',
      provider,
      signal: controller.signal,
    });

    expect(result.finishReason).toBe('aborted');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('passes the signal to a tool as `abortSignal` and aborts during the tool call', async () => {
    let observedAborted: boolean | undefined;
    const slowTool = simpleTool(
      (_args, { abortSignal }) =>
        new Promise((_resolve, reject) => {
          abortSignal?.addEventListener('abort', () => {
            observedAborted = abortSignal.aborted;
            reject(abortSignal.reason);
          });
        })
    );
    const { provider, generate } = scriptedProvider(async () => toolCallResult(toolCall('slow')));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const result = await AgentExecutor.execute({
      agent: agentWithTools('slow'),
      input: 'hi',
      provider,
      toolRegistry: registryWith({ slow: slowTool }),
      signal: controller.signal,
    });

    expect(observedAborted).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.finishReason).toBe('aborted');
    // The transcript stays well-formed: the tool call has a matching result.
    const toolMessage = result.messages.find((m) => m.role === 'tool');
    expect(toolMessage?.toolCallId).toBe('call_slow');
  });

  it('aborting between steps stops before the next model call', async () => {
    const controller = new AbortController();
    const fast = simpleTool(async () => 'done');
    const { provider, generate } = scriptedProvider(async () => toolCallResult(toolCall('fast')));

    const result = await AgentExecutor.execute({
      agent: agentWithTools('fast'),
      input: 'hi',
      provider,
      toolRegistry: registryWith({ fast }),
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'tool-result') controller.abort();
      },
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.finishReason).toBe('aborted');
    expect(result.steps).toBe(1);
    expect(result.messages.at(-1)).toMatchObject({ role: 'tool', content: '"done"' });
  });

  it('skips the remaining tool calls of a turn, giving each a cancelled result', async () => {
    const controller = new AbortController();
    const first = simpleTool(async () => {
      controller.abort();
      return 'first done';
    });
    const secondExecute = vi.fn(async () => 'second done');
    const second = simpleTool(secondExecute);
    const { provider } = scriptedProvider(async () =>
      toolCallResult(toolCall('first'), toolCall('second'))
    );

    const result = await AgentExecutor.execute({
      agent: agentWithTools('first', 'second'),
      input: 'hi',
      provider,
      toolRegistry: registryWith({ first, second }),
      signal: controller.signal,
    });

    expect(secondExecute).not.toHaveBeenCalled();
    expect(result.finishReason).toBe('aborted');
    const toolMessages = result.messages.filter((m) => m.role === 'tool');
    expect(toolMessages.map((m) => m.toolCallId)).toEqual(['call_first', 'call_second']);
    expect(JSON.parse(toolMessages[1].content)).toEqual({
      error: expect.stringContaining('cancelled'),
    });
  });

  it('checkpoints an aborted run so a later run with the same sessionId resumes it', async () => {
    const checkpointStore = createInMemoryCheckpointStore();
    const controller = new AbortController();
    const fast = simpleTool(async () => 'done');
    const first = scriptedProvider(async () => toolCallResult(toolCall('fast')));

    const aborted = await AgentExecutor.execute({
      agent: agentWithTools('fast'),
      input: 'do the thing',
      provider: first.provider,
      toolRegistry: registryWith({ fast }),
      sessionId: 's1',
      checkpointStore,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'tool-result') controller.abort();
      },
    });

    expect(aborted.finishReason).toBe('aborted');
    const saved = checkpointStore.checkpoints.get('s1');
    expect(saved?.finishReason).toBe('aborted');
    expect(saved?.messages.at(-1)).toMatchObject({ role: 'tool', content: '"done"' });

    let sentRoles: string[] = [];
    const second = scriptedProvider(async (options) => {
      sentRoles = options.messages.map((m) => m.role);
      return textResult('all done');
    });
    const resumed = await AgentExecutor.execute({
      agent: agentWithTools('fast'),
      input: 'do the thing', // a retry of the same request: resumes, nothing appended (LOU-U8)
      provider: second.provider,
      toolRegistry: registryWith({ fast }),
      sessionId: 's1',
      checkpointStore,
    });

    expect(resumed.finishReason).toBe('stop');
    expect(resumed.text).toBe('all done');
    expect(resumed.steps).toBe(2);
    expect(sentRoles).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(checkpointStore.checkpoints.get('s1')?.status).toBe('finished');
  });

  it('treats an abort-caused provider rejection as the abort: no compaction, no surfaced retry, no error event', async () => {
    // "Request aborted" would otherwise be categorized as a retryable
    // 'timeout' and folded back into the conversation for another attempt.
    const { provider, generate } = scriptedProvider(
      (options) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('Request aborted')));
        })
    );
    const events: ExecutionEvent[] = [];
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const result = await AgentExecutor.execute({
      agent: agentWithTools(),
      input: 'hi',
      provider,
      maxSteps: 5,
      surfaceRetryableProviderErrors: true,
      signal: controller.signal,
      onEvent: (event) => events.push(event),
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.finishReason).toBe('aborted');
    expect(result.messages.some((m) => m.content.startsWith('[provider-error]'))).toBe(false);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('still rejects for a genuine failure while the signal is not aborted', async () => {
    const { provider } = scriptedProvider(async () => {
      throw new Error('boom');
    });

    await expect(
      AgentExecutor.execute({
        agent: agentWithTools(),
        input: 'hi',
        provider,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow();
  });

  it('a delegated child agent is aborted together with its parent', async () => {
    const child = scriptedProvider(hangUntilAborted);
    const childAgent: AgentConfig = { name: 'Child', agentType: AgentType.SmartAssistant };
    const delegate = createDelegateTool({ agent: childAgent, provider: child.provider });
    const parent = scriptedProvider(async () => ({
      ...toolCallResult({
        id: 'call_delegate',
        type: 'function',
        function: { name: 'delegate', arguments: JSON.stringify({ task: 'sub task' }) },
      }),
    }));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const result = await AgentExecutor.execute({
      agent: agentWithTools('delegate'),
      input: 'hi',
      provider: parent.provider,
      toolRegistry: registryWith({ delegate }),
      signal: controller.signal,
    });

    expect(child.generate).toHaveBeenCalledTimes(1);
    expect(child.generate.mock.calls[0][0].signal?.aborted).toBe(true);
    expect(parent.generate).toHaveBeenCalledTimes(1);
    expect(result.finishReason).toBe('aborted');
  });
});

describe('retry() and aborts (LOU-V1)', () => {
  it('never retries an AbortError, even when shouldRetry says yes', async () => {
    const operation = vi.fn(async () => {
      throw new DOMException('This operation was aborted', 'AbortError');
    });

    await expect(
      retry(operation, { maxAttempts: 3, initialDelayMs: 1, shouldRetry: () => true })
    ).rejects.toThrow('aborted');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('stops retrying once its own signal is aborted', async () => {
    const controller = new AbortController();
    const operation = vi.fn(async () => {
      controller.abort();
      throw new Error('transient');
    });

    await expect(
      retry(operation, {
        maxAttempts: 3,
        initialDelayMs: 1,
        shouldRetry: () => true,
        signal: controller.signal,
      })
    ).rejects.toThrow('transient');
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe('cancellation entry points (LOU-V1)', () => {
  it('createAgent().send(input, { signal }) forwards the signal', async () => {
    const provider = createMockProvider({ name: 'mock' });
    const generateSpy = vi.spyOn(provider, 'generate');
    const agent = createAgent({ prompt: 'p', provider });
    const controller = new AbortController();
    controller.abort();

    const result = await agent.send('hi', { signal: controller.signal });

    expect(result.finishReason).toBe('aborted');
    expect(generateSpy).not.toHaveBeenCalled();
    expect((await agent.send('hi')).finishReason).toBe('stop');
  });

  it('the mock provider rejects with the abort reason before and during its delay', async () => {
    const provider = createMockProvider({ name: 'mock', delay: 60_000 });
    const before = new AbortController();
    before.abort();
    await expect(
      provider.generate({ messages: [], signal: before.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });

    const during = new AbortController();
    setTimeout(() => during.abort(), 10);
    await expect(
      provider.generate({ messages: [], signal: during.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(provider.stream({ messages: [], signal: before.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('resumeAfterApproval() passes the signal to the approved tool and the continued run', async () => {
    const approvalStore = createApprovalStore();
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const guarded = simpleTool(
      async (_args, { abortSignal }) => {
        observedSignal = abortSignal;
        controller.abort();
        return 'approved result';
      },
      { needsApproval: true }
    );
    const toolRegistry = registryWith({ guarded });
    const agent = agentWithTools('guarded');
    const first = scriptedProvider(async () => toolCallResult(toolCall('guarded')));

    const paused = await AgentExecutor.execute({
      agent,
      input: 'hi',
      provider: first.provider,
      toolRegistry,
      approvalStore,
    });
    expect(paused.finishReason).toBe('awaiting-approval');

    const second = scriptedProvider(async () => textResult('never'));
    const resumed = await resumeAfterApproval(
      { id: paused.approvalId!, approved: true },
      approvalStore,
      toolRegistry,
      second.provider,
      { signal: controller.signal }
    );

    expect(observedSignal).toBe(controller.signal);
    expect(second.generate).not.toHaveBeenCalled();
    expect(resumed.finishReason).toBe('aborted');
    expect(resumed.messages.at(-1)).toMatchObject({ role: 'tool', content: '"approved result"' });
  });
});
