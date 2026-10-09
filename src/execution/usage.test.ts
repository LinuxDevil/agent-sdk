import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AgentExecutor } from './AgentExecutor';
import { createAgent } from '../createAgent';
import { resumeAfterApproval } from './resume';
import type { AgentEvent } from './agentEvents';
import type { ApprovalStore, ExecutionSnapshot, PendingApproval } from './ApprovalGate';
import type { Span, TraceExporter } from './tracing';
import type { Checkpoint, CheckpointStore } from './checkpoint';
import { ToolRegistry } from '../tools';
import { defineTool } from '../tools/defineTool';
import type { AgentConfig } from '../types';
import { mockModel } from '../testing';
import { formatUsage, normalizeUsage } from '../models';
import { textOf } from '../providers';

const echo = defineTool({
  name: 'echo',
  description: 'echo',
  input: z.object({}),
  execute: async () => 'echoed',
});

const agent = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  id: 'a',
  name: 'Agent',
  tools: { echo: { tool: 'echo' } },
  ...overrides,
});

const registry = (): ToolRegistry => {
  const r = new ToolRegistry();
  r.registerMany([echo]);
  return r;
};

const callEcho = { toolCalls: [{ name: 'echo' }] };

describe('run usage (LOU-V5)', () => {
  it('accumulates tokens, calls and cost across steps of a priced model', async () => {
    const provider = mockModel(
      [
        { ...callEcho, usage: { inputTokens: 1000, outputTokens: 200 } },
        { text: 'done', usage: { inputTokens: 1500, outputTokens: 300 } },
      ],
      { defaultModel: 'gpt-4o-mini' }
    );

    const result = await AgentExecutor.execute({ agent: agent(), input: 'go', provider, toolRegistry: registry() });

    expect(result.usage).toMatchObject({
      inputTokens: 2500,
      outputTokens: 500,
      totalTokens: 3000,
      modelCalls: 2,
      estimated: false,
      // legacy aliases still work
      promptTokens: 2500,
      completionTokens: 500,
    });
    expect(result.usage.costUsd).toBeCloseTo((2500 * 0.15 + 500 * 0.6) / 1e6, 10);
    expect(result.usage.byModel).toEqual({
      'gpt-4o-mini': { inputTokens: 2500, outputTokens: 500, costUsd: result.usage.costUsd, calls: 2 },
    });
    expect(result.stepUsage).toEqual([
      expect.objectContaining({ step: 1, model: 'gpt-4o-mini', estimated: false, usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 } }),
      expect.objectContaining({ step: 2, model: 'gpt-4o-mini', estimated: false, usage: { inputTokens: 1500, outputTokens: 300, totalTokens: 1800 } }),
    ]);
    expect(formatUsage(result.usage)).toBe('2,500 in / 500 out tokens · $0.0007 (2 model calls)');
  });

  it('Eve PROV-F4: sums cache reads and writes, and prices them at the cache rates', async () => {
    const provider = mockModel(
      [
        { ...callEcho, usage: { inputTokens: 5000, outputTokens: 10, cacheWriteTokens: 4800 } },
        { text: 'done', usage: { inputTokens: 5100, outputTokens: 10, cachedInputTokens: 4800 } },
      ],
      { defaultModel: 'claude-haiku-4-5' }
    );

    const result = await AgentExecutor.execute({ agent: agent(), input: 'go', provider, toolRegistry: registry() });

    expect(result.usage).toMatchObject({ inputTokens: 10100, cachedInputTokens: 4800, cacheWriteTokens: 4800 });
    // Step 1: 200 uncached at $1 + 4,800 written at $1.25; step 2: 300 uncached + 4,800 read at $0.10; 20 out at $5.
    const expected = (500 * 1 + 4800 * 1.25 + 4800 * 0.1 + 20 * 5) / 1e6;
    expect(result.usage.costUsd).toBeCloseTo(expected, 10);
    expect(result.stepUsage?.[1]).toMatchObject({ usage: { cachedInputTokens: 4800 }, costUsd: expect.closeTo((300 + 4800 * 0.1 + 50) / 1e6, 10) });
  });

  it('formatUsage keeps significant digits for a tiny cost (Eve CORE-F17)', () => {
    const base = { inputTokens: 10, outputTokens: 5, modelCalls: 1, estimated: false };
    expect(formatUsage({ ...base, costUsd: 0.000042 })).toBe('10 in / 5 out tokens · $0.000042 (1 model call)');
    expect(formatUsage({ ...base, costUsd: 0.0042 })).toBe('10 in / 5 out tokens · $0.0042 (1 model call)');
    expect(formatUsage({ ...base, costUsd: 0 })).toBe('10 in / 5 out tokens · $0.0000 (1 model call)');
  });

  it('leaves costUsd undefined (not a partial sum) when any model has unknown pricing', async () => {
    const provider = mockModel(
      [
        { ...callEcho, usage: { inputTokens: 100, outputTokens: 10 } },
        { text: 'done', usage: { inputTokens: 100, outputTokens: 10 } },
      ],
      { defaultModel: 'my-private-model' }
    );

    const result = await AgentExecutor.execute({ agent: agent(), input: 'go', provider, toolRegistry: registry() });

    expect(result.usage.costUsd).toBeUndefined();
    expect(result.usage.byModel['my-private-model'].costUsd).toBeUndefined();
    expect(result.usage.totalTokens).toBe(220);
    expect(formatUsage(result.usage)).toBe('200 in / 20 out tokens (2 model calls)');
  });

  it('estimates tokens and flags `estimated` when the provider reports no usage', async () => {
    const provider = mockModel(['hello there']);

    const result = await AgentExecutor.execute({ agent: agent({ prompt: 'be brief' }), input: 'hi', provider });

    expect(result.usage.estimated).toBe(true);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.usage.modelCalls).toBe(1);
    expect(result.stepUsage?.[0].estimated).toBe(true);
    expect(formatUsage(result.usage).startsWith('~')).toBe(true);
  });

  it('only flags the run estimated when some step was estimated, and still sums the reported ones', async () => {
    const provider = mockModel([
      { ...callEcho, usage: { inputTokens: 50, outputTokens: 5 } },
      'no usage here',
    ]);

    const result = await AgentExecutor.execute({ agent: agent(), input: 'go', provider, toolRegistry: registry() });

    expect(result.stepUsage?.map((s) => s.estimated)).toEqual([false, true]);
    expect(result.usage.estimated).toBe(true);
    expect(result.usage.inputTokens).toBeGreaterThan(50);
  });

  it('breaks usage down by model when a sub-agent overrides model', async () => {
    const parentProvider = mockModel(
      [
        { toolCalls: [{ name: 'task', args: { agent: 'child', prompt: 'sub', description: 'child task' } }], usage: { inputTokens: 10, outputTokens: 5 } },
        { text: 'done', usage: { inputTokens: 20, outputTokens: 5 } },
      ],
      { defaultModel: 'gpt-4o-mini' }
    );
    const childProvider = mockModel([{ text: 'sub done', usage: { inputTokens: 100, outputTokens: 50 } }], {
      defaultModel: 'gpt-4o-mini',
    });
    const child = createAgent({ provider: childProvider, model: 'gpt-4o', description: 'Child agent' });

    const result = await AgentExecutor.execute({
      agent: agent(),
      input: 'go',
      provider: parentProvider,
      toolRegistry: registry(),
      subagents: { child },
    });

    expect(childProvider.calls[0].model).toBe('gpt-4o');
    expect(Object.keys(result.usage.byModel).sort()).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(result.usage.byModel['gpt-4o']).toMatchObject({ inputTokens: 100, outputTokens: 50, calls: 1 });
    expect(result.usage.byModel['gpt-4o-mini']).toMatchObject({ inputTokens: 30, outputTokens: 10, calls: 2 });
    const expectedCost = (100 * 2.5 + 50 * 10 + 30 * 0.15 + 10 * 0.6) / 1e6;
    expect(result.usage.costUsd).toBeCloseTo(expectedCost, 10);
  });

  it('rolls a delegated child run up into the parent totals and exposes it as usage.delegated', async () => {
    const parentProvider = mockModel(
      [
        { toolCalls: [{ name: 'task', args: { agent: 'child', prompt: 'sub', description: 'child task' } }], usage: { inputTokens: 10, outputTokens: 5 } },
        { text: 'done', usage: { inputTokens: 20, outputTokens: 5 } },
      ],
      { defaultModel: 'gpt-4o-mini' }
    );
    const childProvider = mockModel(
      [
        { text: 'sub done', usage: { inputTokens: 100, outputTokens: 50 } },
      ],
      { defaultModel: 'gpt-4o-mini' }
    );
    const child = createAgent({ provider: childProvider, description: 'Child agent' });

    const result = await AgentExecutor.execute({
      agent: agent(),
      input: 'go',
      provider: parentProvider,
      toolRegistry: registry(),
      subagents: { child },
    });

    expect(result.usage).toMatchObject({ inputTokens: 130, outputTokens: 60, totalTokens: 190, modelCalls: 3 });
    expect(result.usage.delegated).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      modelCalls: 1,
      runs: 1,
      estimated: false,
    });
    expect(result.usage.delegated?.costUsd).toBeCloseTo((100 * 0.15 + 50 * 0.6) / 1e6, 10);
    // the parent's own steps exclude the child
    expect(result.stepUsage).toHaveLength(2);
    // the model sees the child's answer text plus a small footer, not the usage breakdown
    const toolMessage = result.messages.find((m) => m.role === 'tool');
    expect(textOf(toolMessage!)).toContain('sub done');
    expect(textOf(toolMessage!)).toContain("[sub-agent 'child': 1 step(s), finish reason 'stop'");
  });

  it('continues totals from the checkpoint when a run resumes', async () => {
    const store = checkpointStore();
    const controller = new AbortController();
    const stopper = defineTool({
      name: 'echo',
      description: 'echo',
      input: z.object({}),
      execute: async () => {
        controller.abort();
        return 'echoed';
      },
    });
    const tools = new ToolRegistry();
    tools.registerMany([stopper]);

    const first = await AgentExecutor.execute({
      agent: agent(),
      input: 'go',
      provider: mockModel([{ ...callEcho, usage: { inputTokens: 40, outputTokens: 4 } }], { defaultModel: 'gpt-4o-mini' }),
      toolRegistry: tools,
      sessionId: 's1',
      checkpointStore: store,
      signal: controller.signal,
    });
    expect(first.finishReason).toBe('aborted');
    expect(first.usage.totalTokens).toBe(44);

    const resumed = await AgentExecutor.execute({
      agent: agent(),
      input: 'go',
      provider: mockModel([{ text: 'done', usage: { inputTokens: 60, outputTokens: 6 } }], { defaultModel: 'gpt-4o-mini' }),
      toolRegistry: registry(),
      sessionId: 's1',
      checkpointStore: store,
    });

    expect(resumed.usage).toMatchObject({ inputTokens: 100, outputTokens: 10, totalTokens: 110, modelCalls: 2 });
    expect(resumed.usage.byModel['gpt-4o-mini']).toMatchObject({ inputTokens: 100, calls: 2 });
    expect(resumed.stepUsage).toHaveLength(2);
  });

  it('keeps the totals of a run paused for approval when it is resumed', async () => {
    const records = new Map<string, { pending: PendingApproval; snapshot: ExecutionSnapshot }>();
    const approvalStore: ApprovalStore = {
      async save(pending, snapshot) {
        records.set(pending.id, { pending, snapshot });
      },
      async resolve(id) {
        const record = records.get(id) ?? null;
        records.delete(id);
        return record;
      },
    };
    const gated = defineTool({ name: 'echo', description: 'echo', input: z.object({}), needsApproval: true, execute: async () => 'ok' });
    const tools = new ToolRegistry();
    tools.registerMany([gated]);
    const provider = mockModel(
      [
        { ...callEcho, usage: { inputTokens: 40, outputTokens: 4 } },
        { text: 'done', usage: { inputTokens: 60, outputTokens: 6 } },
      ],
      { defaultModel: 'gpt-4o-mini' }
    );

    const paused = await AgentExecutor.execute({ agent: agent(), input: 'go', provider, toolRegistry: tools, approvalStore });
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(paused.usage.totalTokens).toBe(44);

    const resumed = await resumeAfterApproval({ id: paused.approvalId!, approved: true }, approvalStore, tools, provider);

    expect(resumed.usage).toMatchObject({ inputTokens: 100, outputTokens: 10, modelCalls: 2 });
  });

  it('starts from the old token counts when the checkpoint predates usage tracking', async () => {
    const store = checkpointStore();
    await store.save('old', {
      agentId: 'a',
      sessionId: 'old',
      stepIndex: 1,
      messages: [{ role: 'user', content: 'go' }],
      toolCalls: [],
      usage: { promptTokens: 30, completionTokens: 3, totalTokens: 33 },
    });

    const result = await AgentExecutor.execute({
      agent: agent(),
      input: 'ignored',
      provider: mockModel([{ text: 'done', usage: { inputTokens: 10, outputTokens: 1 } }], { defaultModel: 'gpt-4o-mini' }),
      sessionId: 'old',
      checkpointStore: store,
    });

    expect(result.usage).toMatchObject({ inputTokens: 40, outputTokens: 4, totalTokens: 44, modelCalls: 1 });
    // the earlier tokens have no known model, so no (partial) cost is claimed
    expect(result.usage.costUsd).toBeUndefined();
  });

  it('reports usage on events, onLLMResponse and the chat span from the same numbers', async () => {
    const events: AgentEvent[] = [];
    const seen: unknown[] = [];
    const tracer = createTracer();
    const provider = mockModel([{ text: 'done', usage: { inputTokens: 7, outputTokens: 3 } }], {
      defaultModel: 'gpt-4o-mini',
    });

    const result = await AgentExecutor.execute({
      agent: agent(),
      input: 'go',
      provider,
      exporter: tracer.exporter,
      onAgentEvent: (e) => events.push(e),
      onLLMResponse: (_response, _latency, usage) => {
        seen.push(usage);
      },
    });

    const runDone = events.find((e) => e.type === 'run.done');
    expect(runDone?.usage).toMatchObject({ inputTokens: 7, outputTokens: 3, modelCalls: 1 });
    expect(events.find((e) => e.type === 'step.done')?.usage).toMatchObject(result.stepUsage?.[0]?.usage ?? {});
    expect(seen).toEqual([expect.objectContaining({ model: 'gpt-4o-mini', usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } })]);
    const chat = tracer.spans().find((s) => s.name.startsWith('chat'));
    expect(chat?.attributes['gen_ai.usage.input_tokens']).toBe(7);
    expect(chat?.attributes['gen_ai.usage.output_tokens']).toBe(3);
    expect(chat?.attributes['lousho.usage.estimated']).toBeUndefined();
  });

  it('marks the chat span estimated when usage was estimated', async () => {
    const tracer = createTracer();
    await AgentExecutor.execute({ agent: agent(), input: 'go', provider: mockModel(['hi']), exporter: tracer.exporter });

    const chat = tracer.spans().find((s) => s.name.startsWith('chat'));
    expect(chat?.attributes['lousho.usage.estimated']).toBe(true);
    expect(chat?.attributes['gen_ai.usage.input_tokens']).toBeGreaterThan(0);
  });
});

describe('usage on the event stream (LOU-V5)', () => {
  it('puts per-step and run usage, cost and the estimated flag on step.done and run.done', async () => {
    const provider = mockModel(
      [
        { ...callEcho, usage: { inputTokens: 1000, outputTokens: 200 } },
        'no usage reported',
      ],
      { defaultModel: 'gpt-4o-mini' }
    );

    const events: AgentEvent[] = [];
    for await (const event of AgentExecutor.stream({ agent: agent(), input: 'go', provider, toolRegistry: registry() })) {
      events.push(event);
    }

    const [first, second] = events.filter((e) => e.type === 'step.done');
    expect(first.usage).toMatchObject({ inputTokens: 1000, outputTokens: 200, promptTokens: 1000, estimated: false });
    expect(first.usage?.costUsd).toBeCloseTo((1000 * 0.15 + 200 * 0.6) / 1e6, 10);
    expect(second.usage?.estimated).toBe(true);
    const done = events.find((e) => e.type === 'run.done');
    expect(done?.usage).toMatchObject({ modelCalls: 2, estimated: true });
    expect(done?.usage?.inputTokens).toBeGreaterThan(1000);
  });

  it('rolls delegated children up into a streamed run as well', async () => {
    const parentProvider = mockModel(
      [
        { toolCalls: [{ name: 'task', args: { agent: 'child', prompt: 'sub', description: 'child task' } }], usage: { inputTokens: 10, outputTokens: 5 } },
        { text: 'done', usage: { inputTokens: 20, outputTokens: 5 } },
      ],
      { defaultModel: 'gpt-4o-mini' }
    );
    const childProvider = mockModel([{ text: 'sub', usage: { inputTokens: 100, outputTokens: 50 } }], { defaultModel: 'gpt-4o-mini' });
    const child = createAgent({ provider: childProvider, description: 'Child agent' });

    const events: AgentEvent[] = [];
    for await (const event of AgentExecutor.stream({
      agent: agent(),
      input: 'go',
      provider: parentProvider,
      toolRegistry: registry(),
      subagents: { child },
    })) {
      events.push(event);
    }

    expect(events.find((e) => e.type === 'run.done')?.usage).toMatchObject({ inputTokens: 130, outputTokens: 60, modelCalls: 3 });
  });
});

describe('normalizeUsage', () => {
  it('maps provider names, keeps cache/reasoning tokens when present, and rejects NaN or missing usage', () => {
    expect(normalizeUsage({ promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedInputTokens: 4, reasoningTokens: 2 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cachedInputTokens: 4,
      reasoningTokens: 2,
    });
    expect(normalizeUsage({ promptTokens: NaN, completionTokens: NaN, totalTokens: NaN })).toBeUndefined();
    expect(normalizeUsage(undefined)).toBeUndefined();
    expect(normalizeUsage({ promptTokens: 1, completionTokens: 2, totalTokens: NaN })?.totalTokens).toBe(3);
  });
});

describe('formatUsage', () => {
  it('formats singular calls, large costs and estimates', () => {
    const base = { inputTokens: 1234, outputTokens: 567, costUsd: 12.345, modelCalls: 1, estimated: false };
    expect(formatUsage(base)).toBe('1,234 in / 567 out tokens · $12.35 (1 model call)');
    expect(formatUsage({ ...base, costUsd: undefined, estimated: true })).toBe('~1,234 in / 567 out tokens (1 model call)');
  });
});

function createTracer() {
  const ended: Span[] = [];
  const exporter: TraceExporter = { onSpanStart: () => undefined, onSpanEnd: (span) => void ended.push({ ...span }) };
  return { exporter, spans: () => ended };
}

function checkpointStore(): CheckpointStore {
  const checkpoints = new Map<string, Checkpoint>();
  return {
    async save(sessionId, checkpoint) {
      checkpoints.set(sessionId, JSON.parse(JSON.stringify(checkpoint)));
    },
    async load(sessionId) {
      return checkpoints.get(sessionId) ?? null;
    },
    async delete(sessionId) {
      checkpoints.delete(sessionId);
    },
  };
}
