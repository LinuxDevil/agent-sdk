/**
 * H3-3 / H3-6 / H1-3: a run says when its tools failed (`result.toolErrors`,
 * `limits.maxToolErrors`), a rejected run says what it spent (`error.usage`),
 * a sub-agent's spend survives a crash of its lead (`delegatedInFlight`), and a
 * checkpointed run that rejects records why (`agent.pending()`'s `lastError`).
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockTurn } from '../testing';
import { memoryStore } from '../storage/agentStore';
import { BudgetExceededError } from './budget';
import { PropagatingToolError } from './AgentExecutor';
import { SDKError } from './errors';
import type { RunUsage } from '../models/usage';

const usage = { inputTokens: 10, outputTokens: 5 };
const call = (name: string): MockTurn => ({ toolCalls: [{ name }], usage });
const answer = (text: string): MockTurn => ({ text, usage });

const stats = defineTool({
  name: 'stats',
  description: 'stats',
  input: z.object({}),
  execute: async () => {
    throw new Error('stats backend down');
  },
});
const ok = defineTool({ name: 'ok', description: 'ok', input: z.object({}), execute: async () => 'fine' });

describe('result.toolErrors (H3-3)', () => {
  it('counts the tool calls that failed, even when the model then answers normally', async () => {
    const agent = createAgent({ provider: mockModel([call('stats'), call('ok'), call('stats'), answer('All good: 42.')]), tools: [stats, ok] });

    const result = await agent.send('report');

    expect(result.finishReason).toBe('stop');
    expect(result.toolErrors).toBe(2);
  });

  it('is absent when no tool call failed, and does not count calls that never ran', async () => {
    const clean = await createAgent({ provider: mockModel([call('ok'), answer('done')]), tools: [ok] }).send('go');
    expect(clean.toolErrors).toBeUndefined();

    // A budget stop gives the unrun `ok` call a `not-run` error result: not a tool failure.
    const stopped = await createAgent({ provider: mockModel([call('ok')]), tools: [ok], limits: { maxTokens: 1 } }).send('go');
    expect(stopped.finishReason).toBe('budget-exceeded');
    expect(stopped.messages.some((m) => m.role === 'tool' && m.isError)).toBe(true);
    expect(stopped.toolErrors).toBeUndefined();
  });

  it('limits.maxToolErrors stops the run before its next model call once that many calls failed', async () => {
    const model = mockModel([call('stats'), call('stats'), answer('fabricated')]);
    const agent = createAgent({ provider: model, tools: [stats], limits: { maxToolErrors: 2 } });

    const result = await agent.send('report');

    expect(result.finishReason).toBe('budget-exceeded');
    expect(result.budget).toEqual({ limit: 'maxToolErrors', value: 2, max: 2, scope: 'run' });
    expect(result.toolErrors).toBe(2);
    expect(model.calls).toHaveLength(2);
    expect(result.text).not.toContain('fabricated');
  });

  it("limits.maxToolErrors with onExceeded: 'throw' rejects with BudgetExceededError", async () => {
    const agent = createAgent({ provider: mockModel([call('stats'), answer('x')]), tools: [stats], limits: { maxToolErrors: 1, onExceeded: 'throw' } });

    const error = await agent.send('report').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BudgetExceededError);
    expect((error as BudgetExceededError).budget.limit).toBe('maxToolErrors');
  });

  it("a session's limits.maxToolErrors counts each turn's failures", async () => {
    const agent = createAgent({ provider: mockModel([call('stats'), answer('one'), call('stats'), answer('two')]), tools: [stats] });
    const session = agent.session({ id: 'tool-errors', limits: { maxToolErrors: 2 } });

    expect((await session.send('a')).finishReason).toBe('stop');
    const second = await session.send('b');
    expect(second.finishReason).toBe('stop');
    expect(second.toolErrors).toBe(1);
  });
});

describe('error.usage (H3-6)', () => {
  it('a run rejected by a PropagatingToolError carries what it spent', async () => {
    const fatal = defineTool({
      name: 'fatal',
      description: 'fatal',
      input: z.object({}),
      execute: async () => {
        throw new PropagatingToolError('stop now');
      },
    });
    const agent = createAgent({ provider: mockModel([call('ok'), call('fatal')]), tools: [ok, fatal] });

    const error = (await agent.send('go').catch((e: unknown) => e)) as PropagatingToolError;

    expect(error).toBeInstanceOf(PropagatingToolError);
    expect(error.usage).toMatchObject({ inputTokens: 20, outputTokens: 10, modelCalls: 2 });
    // Not enumerable: logging or serialising the error is unchanged.
    expect(Object.keys(error)).not.toContain('usage');
  });

  it('a run rejected by a provider error carries the model calls before it', async () => {
    const outage = Object.assign(new Error('503 upstream down'), { status: 503 });
    const agent = createAgent({ provider: mockModel([call('ok'), { error: outage }], { onExhausted: 'repeat-last' }), tools: [ok], retry: false });

    const error = (await agent.send('go').catch((e: unknown) => e)) as SDKError;

    expect(error.usage?.modelCalls).toBe(1);
    expect(error.usage?.inputTokens).toBe(10);
  });

  it("keeps an error's own usage property", async () => {
    const own = Object.assign(new PropagatingToolError('own'), { usage: { mine: true } as unknown as RunUsage });
    const fatal = defineTool({
      name: 'fatal',
      description: 'fatal',
      input: z.object({}),
      execute: async () => {
        throw own;
      },
    });
    const error = (await createAgent({ provider: mockModel([call('fatal')]), tools: [fatal] }).send('go').catch((e: unknown) => e)) as PropagatingToolError;

    expect(error.usage).toEqual({ mine: true });
  });
});

describe('sub-agent usage across a crash of its lead (H3-6)', () => {
  it("checkpoints a running sub-agent's spend, and a resumed lead counts it", async () => {
    let release: () => void = () => undefined;
    let hang = true;
    const slow = defineTool({
      name: 'slow',
      description: 'slow',
      input: z.object({}),
      execute: async () => {
        if (hang) await new Promise<void>((resolve) => (release = resolve));
        return 'slow done';
      },
    });
    const childScript = [call('ok'), call('slow'), answer('child done')];
    const child = createAgent({ provider: mockModel(childScript), tools: [ok, slow], instructions: 'Child.', description: 'Child' });
    const taskCall: MockTurn = { toolCalls: [{ name: 'task', args: { agent: 'child', description: 'a task', prompt: 'work' } }], usage };
    const store = memoryStore();
    const lead = createAgent({ provider: mockModel([taskCall, answer('lead done')]), store, subagents: { child } });

    const running = lead.send('go', { sessionId: 'orchestrator' });
    await vi.waitFor(async () => expect((await store.checkpoints!.load('orchestrator'))?.delegatedInFlight?.[0]?.modelCalls).toBe(2));

    // "Kill" the lead: copy its checkpoint as it stands into a fresh store and resume there.
    const crashed = await store.checkpoints!.load('orchestrator');
    const restarted = memoryStore();
    await restarted.checkpoints!.save('orchestrator', crashed!);
    hang = false;
    const child2 = createAgent({ provider: mockModel([answer('child redo')]), tools: [ok, slow], instructions: 'Child.', description: 'Child' });
    const lead2 = createAgent({ provider: mockModel([answer('lead done')]), store: restarted, subagents: { child: child2 } });

    const resumed = await lead2.resume('orchestrator');

    // Lead's task call (1) + the interrupted child's 2 calls + the re-run child (1) + the lead's answer (1).
    expect(resumed?.usage.modelCalls).toBe(5);
    expect(resumed?.usage.delegated?.runs).toBe(2);
    expect((await restarted.checkpoints!.load('orchestrator'))?.delegatedInFlight).toBeUndefined();

    release();
    const first = await running;
    expect(first.usage.modelCalls).toBe(5);
    expect((await store.checkpoints!.load('orchestrator'))?.delegatedInFlight).toBeUndefined();
  });
});

describe('lastError of a failed run in agent.pending() (H1-3)', () => {
  it('records why a send(msg, { sessionId }) run rejected, and counts the attempts', async () => {
    const outage = Object.assign(new Error('503 upstream down'), { status: 503 });
    const store = memoryStore();
    const agent = createAgent({ provider: mockModel([call('ok'), { error: outage }], { onExhausted: 'repeat-last' }), tools: [ok], store, retry: false });

    await expect(agent.send('go', { sessionId: 'job-1' })).rejects.toThrow();
    const [pending] = await agent.pending();

    expect(pending).toMatchObject({ sessionId: 'job-1', kind: 'run', status: 'in-progress', attempts: 1 });
    expect(pending.lastError).toMatchObject({ retryable: true });
    expect(pending.lastError?.message).toContain('503');

    await expect(agent.resume('job-1')).rejects.toThrow();
    expect((await agent.pending())[0]).toMatchObject({ attempts: 2 });
  });
});
