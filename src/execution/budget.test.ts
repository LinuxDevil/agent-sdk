import { afterEach, describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { AgentExecutor, type ExecuteOptions } from './AgentExecutor';
import { BudgetExceededError, type RunLimits } from './budget';
import type { AgentEvent } from './agentEvents';
import { ToolRegistry } from '../tools';
import { defineTool } from '../tools/defineTool';
import type { AgentConfig } from '../types';
import { mockModel, type MockTurn } from '../testing';
import { createAgent } from '../createAgent';
import { memoryStore } from '../storage/agentStore';
import { MemorySessionStore } from '../session';

let echoRuns = 0;
const echo = defineTool({
  name: 'echo',
  description: 'echo',
  input: z.object({}),
  execute: async () => {
    echoRuns++;
    return 'echoed';
  },
});

const agent: AgentConfig = { id: 'a', name: 'Agent', tools: { echo: { tool: 'echo' } } };
const registry = (): ToolRegistry => {
  const r = new ToolRegistry();
  r.registerMany([echo]);
  return r;
};
const callEcho = (inputTokens: number, outputTokens: number): MockTurn => ({
  toolCalls: [{ name: 'echo' }],
  usage: { inputTokens, outputTokens },
});
// gpt-4o-mini: $0.15 / $0.60 per million input / output tokens.
const priced = (script: MockTurn[]) => mockModel(script, { defaultModel: 'gpt-4o-mini', onExhausted: 'repeat-last' });
const run = (limits: RunLimits, script: MockTurn[], extra: Partial<ExecuteOptions> = {}) =>
  AgentExecutor.execute({ agent, input: 'go', provider: priced(script), toolRegistry: registry(), limits, ...extra });

afterEach(() => {
  echoRuns = 0;
  vi.useRealTimers();
});

describe('limits (LOU-V6)', () => {
  it.each([
    ['maxTokens', { maxTokens: 250 }, 300],
    ['maxInputTokens', { maxInputTokens: 150 }, 200],
    ['maxOutputTokens', { maxOutputTokens: 80 }, 100],
  ] as const)('%s stops the run after the model call that reaches it, before its tools run', async (limit, limits, value) => {
    const result = await run(limits, [callEcho(100, 50)]);

    expect(result.finishReason).toBe('budget-exceeded');
    expect(result.budget).toEqual({ limit, value, max: Object.values(limits)[0], scope: 'run' });
    expect(result.steps).toBe(2);
    expect(echoRuns).toBe(1);
    // The unrun call gets a cancelled result, so the transcript stays valid for a provider.
    const last = result.messages.at(-1)!;
    expect(last.role).toBe('tool');
    expect(JSON.parse(last.content as string).message).toMatch(/budget limit/);
  });

  it('maxCostUsd counts the estimated cost', async () => {
    const result = await run({ maxCostUsd: 0.0004 }, [callEcho(1000, 500)]);
    // one call: (1000 * 0.15 + 500 * 0.6) / 1e6 = 0.00045
    expect(result.finishReason).toBe('budget-exceeded');
    expect(result.budget).toMatchObject({ limit: 'maxCostUsd', max: 0.0004, scope: 'run' });
    expect(result.budget?.value).toBeCloseTo(0.00045, 10);
    expect(result.steps).toBe(1);
  });

  it('limits.maxSteps is an alias of maxSteps: the stricter wins', async () => {
    const byLimit = await run({ maxSteps: 2 }, [callEcho(1, 1)], { maxSteps: 5 });
    expect(byLimit.finishReason).toBe('budget-exceeded');
    expect(byLimit.budget).toEqual({ limit: 'maxSteps', value: 2, max: 2, scope: 'run' });
    expect(echoRuns).toBe(2);

    const byOption = await run({ maxSteps: 5 }, [callEcho(1, 1)], { maxSteps: 2 });
    expect(byOption.finishReason).toBe('max-steps');
    expect(byOption.budget).toBeUndefined();

    // Alone, it replaces the default of 10 steps.
    const alone = await run({ maxSteps: 12 }, [callEcho(1, 1)]);
    expect(alone.steps).toBe(12);
    expect(alone.budget?.limit).toBe('maxSteps');
  });

  it('a run that finishes within its limits is unchanged', async () => {
    const result = await run({ maxTokens: 1000 }, [callEcho(100, 50), { text: 'done', usage: { inputTokens: 100, outputTokens: 50 } }]);
    expect(result.finishReason).toBe('stop');
    expect(result.budget).toBeUndefined();
  });

  it('streams budget.exceeded before run.done and checkpoints the run like max-steps', async () => {
    const { checkpoints } = memoryStore();
    const stream = AgentExecutor.stream({
      agent,
      input: 'go',
      provider: priced([callEcho(100, 50)]),
      toolRegistry: registry(),
      limits: { maxTokens: 200 },
      sessionId: 'job-1',
      checkpointStore: checkpoints,
    });
    const events: AgentEvent[] = [];
    for await (const event of stream) events.push(event);

    const types = events.map((e) => e.type);
    expect(types.slice(-3)).toEqual(['budget.exceeded', 'step.done', 'run.done']);
    expect(events.find((e) => e.type === 'budget.exceeded')).toMatchObject({ limit: 'maxTokens', value: 300, max: 200, scope: 'run' });
    expect(events.at(-1)).toMatchObject({ type: 'run.done', finishReason: 'budget-exceeded' });
    const checkpoint = await checkpoints!.load('job-1');
    expect(checkpoint).toMatchObject({ status: 'finished', finishReason: 'budget-exceeded', stepIndex: 2 });
    expect(checkpoint?.messages).toEqual((await stream.result).messages);
  });

  it("onExceeded: 'throw' rejects with BudgetExceededError", async () => {
    const error = await run({ maxTokens: 100, onExceeded: 'throw' }, [callEcho(100, 50)]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(error).toMatchObject({ code: 'LOUSHY_BUDGET_EXCEEDED', budget: { limit: 'maxTokens', value: 150, max: 100 } });
  });

  it('maxDurationMs aborts an in-flight model call', async () => {
    vi.useFakeTimers();
    const hanging: MockTurn = (request) =>
      new Promise((_, reject) => request.signal?.addEventListener('abort', () => reject(request.signal?.reason)));
    const pending = run({ maxDurationMs: 5_000 }, [callEcho(10, 10), hanging]);

    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;

    expect(result.finishReason).toBe('budget-exceeded');
    expect(result.budget).toEqual({ limit: 'maxDurationMs', value: 5_000, max: 5_000, scope: 'run' });
    expect(result.steps).toBe(2);
  });

  it("maxDurationMs with onExceeded: 'throw' rejects", async () => {
    vi.useFakeTimers();
    const hanging: MockTurn = (request) =>
      new Promise((_, reject) => request.signal?.addEventListener('abort', () => reject(request.signal?.reason)));
    const pending = run({ maxDurationMs: 1_000, onExceeded: 'throw' }, [hanging]).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toBeInstanceOf(BudgetExceededError);
  });

  it("counts a sub-agent's usage toward the parent's budget", async () => {
    const researcher = createAgent({
      description: 'Researches',
      provider: priced([{ text: 'found it', usage: { inputTokens: 400, outputTokens: 100 } }]),
    });
    const lead = createAgent({
      provider: priced([
        {
          toolCalls: [{ name: 'task', args: { agent: 'researcher', prompt: 'look', description: 'look' } }],
          usage: { inputTokens: 10, outputTokens: 10 },
        },
        'done',
      ]),
      subagents: { researcher },
      limits: { maxTokens: 300 },
    });

    const result = await lead.send('research');

    expect(result.finishReason).toBe('budget-exceeded');
    expect(result.budget).toEqual({ limit: 'maxTokens', value: 520, max: 300, scope: 'run' });
    expect(result.usage.delegated?.totalTokens).toBe(500);
  });
});

describe('session limits (LOU-V6)', () => {
  it('maxCostUsd holds across turns, from the persisted usage', async () => {
    // Each call: (1000 * 0.15 + 1000 * 0.6) / 1e6 = 0.00075
    const usage = { inputTokens: 1000, outputTokens: 1000 };
    const provider = priced([{ text: 'one', usage }, { toolCalls: [{ name: 'echo' }], usage }]);
    const agent = createAgent({ provider, tools: [echo] });
    const store = new MemorySessionStore();
    const limits = { maxCostUsd: 0.0012 };

    const first = await agent.session({ id: 's1', store, limits }).send('first');
    expect(first.finishReason).toBe('stop');

    const second = await agent.session({ id: 's1', store, limits }).send('second');
    expect(second.finishReason).toBe('budget-exceeded');
    expect(second.budget).toMatchObject({ limit: 'maxCostUsd', max: 0.0012, scope: 'session' });
    expect(second.budget?.value).toBeCloseTo(0.0015, 10);
    expect(second.usage.costUsd).toBeCloseTo(0.00075, 10);
    expect(echoRuns).toBe(0);

    // A later turn stops before calling the model.
    const calls = provider.calls.length;
    const third = await agent.session({ id: 's1', store, limits }).send('third');
    expect(third).toMatchObject({ finishReason: 'budget-exceeded', steps: 0 });
    expect(provider.calls.length).toBe(calls);
    const saved = (await store.load('s1'))!;
    expect(saved.at(-1)?.metadata?.sessionUsage).toMatchObject({ totalTokens: 4000, steps: 2 });
  });

  it('run limits still apply per turn', async () => {
    const agent = createAgent({ provider: priced([callEcho(100, 100)]), tools: [echo], limits: { maxTokens: 250 } });
    const result = await agent.session({ limits: { maxTokens: 10_000 } }).send('go');
    expect(result.budget).toEqual({ limit: 'maxTokens', value: 400, max: 250, scope: 'run' });
  });
});
