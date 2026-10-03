/**
 * LOU-W3.2: `compaction.start` / `compaction.done` stream events and
 * `createAgent({ compaction, hooks })`. No network: scripted `mockModel`s.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgent, type CreateAgentConfig } from '../createAgent';
import { LLMProviderRegistry } from '../providers/llm';
import type { Message } from '../providers';
import { textOf } from '../providers';
import { estimateTokens } from '../models';
import { defineTool } from '../tools/defineTool';
import type { AgentEvent, AgentEventOf, AgentRun, AgentHook } from '../execution';
import { mockModel } from '../testing';
import { createCompactionHook, type CompactionStrategy } from './compaction';

const BIG = 'x'.repeat(4_000); // about 1,000 tokens
const HUGE = 'y'.repeat(150_000); // about 37,500 tokens

const fetchPage = (size: string) =>
  defineTool({
    name: 'fetch_page',
    description: 'Fetch a page',
    input: z.object({ n: z.number() }),
    execute: async ({ n }) => `${n}:${size}`,
  });

const pageCall = (n: number) => ({ toolCalls: [{ name: 'fetch_page', args: { n }, id: `call_${n}` }] });

async function collect(run: AgentRun): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

const ofType = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is AgentEventOf<T> => e.type === type);

/** A small window: compaction starts once a request passes 2,700 tokens. */
const SMALL = { contextWindow: 3_000, protectedTokens: 1_500 };
const SUMMARIZING = { contextWindow: 3_000, protectedTokens: 1_000, thresholdPercent: 0.3 };

function agentWith(compaction: CreateAgentConfig['compaction'], size = BIG, extra: Partial<CreateAgentConfig> = {}) {
  const model = mockModel([pageCall(1), pageCall(2), pageCall(3), pageCall(4), 'done']);
  const agent = createAgent({ provider: model, tools: [fetchPage(size)], maxSteps: 10, compaction, ...extra });
  return { agent, model };
}

describe('compaction stream events (LOU-W3.2)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('emits compaction.start then compaction.done inside the step, before the model call that triggered them', async () => {
    const { agent, model } = agentWith(SMALL);
    const run = agent.stream('read four pages');
    const events = await collect(run);
    const result = await run.result;

    expect(result.text).toBe('done');
    const types = events.map((e) => e.type);
    const start = types.indexOf('compaction.start');
    expect(start).toBeGreaterThan(0);
    expect(types[start - 1]).toBe('step.start');
    expect(types[start + 1]).toBe('compaction.done');
    // The model call of that step comes after: its text events follow the compaction.
    expect(types.slice(start + 2)).toContain('text.delta');
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));

    const [started] = ofType(events, 'compaction.start');
    const [done] = ofType(events, 'compaction.done');
    expect(started).toMatchObject({ strategy: 'prune-tool-results', contextWindow: 3_000, thresholdTokens: 2_700 });
    expect(started.tokensBefore).toBeGreaterThan(2_700);
    expect(done).toMatchObject({
      strategy: 'prune-tool-results',
      tokensBefore: started.tokensBefore,
      prunedToolCallIds: ['call_1', 'call_2'],
    });
    expect(done.tokensAfter).toBeLessThan(done.tokensBefore);
    expect(done).not.toHaveProperty('summary');
    expect(done).not.toHaveProperty('error');
    // Every start has exactly one done, and the request of that step was already compacted.
    expect(ofType(events, 'compaction.start')).toHaveLength(ofType(events, 'compaction.done').length);
    expect(estimateTokens(model.calls.at(-1)?.messages as Message[])).toBeLessThan(2_700);
    // Events are plain JSON.
    expect(JSON.parse(JSON.stringify(started))).toEqual(started);
  });

  it('emits nothing below the threshold, and nothing from a non-streaming send()', async () => {
    const quiet = agentWith({ contextWindow: 1_000_000 });
    expect(ofType(await collect(quiet.agent.stream('go')), 'compaction.start')).toEqual([]);

    const { agent, model } = agentWith(SMALL);
    const result = await agent.send('read four pages');
    expect(result.text).toBe('done');
    expect(result.messages.some((m) => textOf(m).startsWith('[pruned: fetch_page result'))).toBe(true);
    expect(model.calls).toHaveLength(5);
  });

  it('createAgent({ compaction: true }) compacts a long transcript with the defaults', async () => {
    const { agent, model } = agentWith(true, HUGE);
    const run = agent.stream('read four pages');
    const events = await collect(run);
    const result = await run.result;

    expect(result.text).toBe('done');
    const [started] = ofType(events, 'compaction.start');
    const [done] = ofType(events, 'compaction.done');
    expect(started).toMatchObject({ strategy: 'prune-tool-results', contextWindow: 128_000 });
    expect(done.prunedToolCallIds.length).toBeGreaterThan(0);
    expect(done.tokensAfter).toBeLessThan(started.thresholdTokens);
    const markers = result.messages.filter((m) => m.role === 'tool' && textOf(m).startsWith('[pruned: fetch_page result'));
    expect(markers.map((m) => m.toolCallId)).toEqual(done.prunedToolCallIds);
    expect(model.calls).toHaveLength(5);
  });

  it('an object with a summarizer provider runs twoPhaseStrategy with it', async () => {
    const summarizer = mockModel(['The user wants four pages read.']);
    const { agent, model } = agentWith({ ...SUMMARIZING, summarizer });
    const run = agent.stream('read four pages');
    const events = await collect(run);

    expect((await run.result).text).toBe('done');
    expect(summarizer.calls.length).toBeGreaterThan(0);
    const done = ofType(events, 'compaction.done').find((e) => e.summary);
    expect(done).toMatchObject({ strategy: 'two-phase', summary: true });
    expect(done).not.toHaveProperty('error');
    expect(JSON.stringify(model.calls.at(-1)?.messages)).toContain('[Conversation summary]\\nThe user wants four pages read.');
  });

  it("resolves a 'provider/model' summarizer with the provider registry", async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const summarizer = mockModel(['A summary.']);
    const create = vi.spyOn(LLMProviderRegistry, 'create').mockReturnValue(summarizer);
    const { agent } = agentWith({ ...SUMMARIZING, summarizer: 'openai/gpt-4o-mini' });

    const events = await collect(agent.stream('read four pages'));

    expect(create.mock.calls[0]?.[0]).toBe('openai');
    expect(summarizer.calls.length).toBeGreaterThan(0);
    expect(ofType(events, 'compaction.done').some((e) => e.summary)).toBe(true);
  });

  it('reports a failing strategy as compaction.done with an error and keeps the run going', async () => {
    const strategy: CompactionStrategy = {
      name: 'boom',
      compact() {
        throw new Error('strategy exploded');
      },
    };
    const { agent } = agentWith({ ...SMALL, strategy });
    const run = agent.stream('read four pages');
    const events = await collect(run);

    expect((await run.result).text).toBe('done');
    const [done] = ofType(events, 'compaction.done');
    expect(done).toMatchObject({ strategy: 'boom', prunedToolCallIds: [], error: { message: 'strategy exploded' } });
    expect(done.tokensAfter).toBe(done.tokensBefore);
  });

  it('reports a failed summarizer (fallback to pruning) on compaction.done', async () => {
    const summarizer = mockModel([{ error: new Error('summarizer down') }]);
    const { agent } = agentWith({ ...SUMMARIZING, summarizer });
    const events = await collect(agent.stream('read four pages'));

    const failed = ofType(events, 'compaction.done').find((e) => e.error);
    expect(failed).toMatchObject({ strategy: 'two-phase', error: { message: 'summarizer down' } });
    expect(failed?.summary).toBeUndefined();
  });

  it("tags a sub-agent's compaction events with `subagent`", async () => {
    const child = createAgent({
      provider: mockModel([pageCall(1), pageCall(2), pageCall(3), pageCall(4), 'child done']),
      tools: [fetchPage(BIG)],
      description: 'Reads pages',
      maxSteps: 10,
    });
    const lead = createAgent({
      provider: mockModel([{ toolCalls: [{ name: 'task', args: { agent: 'reader', prompt: 'read', description: 'read pages' }, id: 't1' }] }, 'lead done']),
      subagents: { reader: child },
      hooks: [createCompactionHook(SMALL)],
    });
    const events = await collect(lead.stream('go'));
    const started = ofType(events, 'compaction.start');
    expect(started.length).toBeGreaterThan(0);
    expect(started.every((e) => e.subagent?.name === 'reader')).toBe(true);
  });
});

describe('createAgent({ hooks, compaction }) options (LOU-W3.2)', () => {
  it('forwards `hooks`: they run around every model call, in order, before the compaction hook', async () => {
    const seen: string[] = [];
    const { agent } = agentWith(SMALL, BIG, {
      hooks: [
        { name: 'a', preGenerate: () => void seen.push('a') },
        {
          name: 'b',
          preToolCall: (ctx) => void seen.push(`tool:${ctx.toolName}`),
          // Runs before compaction, so compaction sees what it added.
          preGenerate: (ctx) => void seen.push(`b:${ctx.request.messages.length}`),
        },
      ],
    });
    await agent.send('read four pages');
    expect(seen.slice(0, 3)).toEqual(['a', 'b:2', 'tool:fetch_page']);
    expect(seen.filter((s) => s === 'a')).toHaveLength(5);
    expect(seen.filter((s) => s === 'tool:fetch_page')).toHaveLength(4);
  });

  it('lets a hook add events with ctx.emit when the run has listeners or is streamed', async () => {
    const hook: AgentHook = {
      name: 'emitter',
      preGenerate: (ctx) =>
        ctx.emit?.({ type: 'compaction.start', strategy: 'custom', tokensBefore: 1, contextWindow: 2, thresholdTokens: 3 }),
    };
    const expected = ['run.start', 'step.start', 'compaction.start', 'text.delta', 'text.done', 'step.done', 'run.done'];
    const agent = createAgent({ provider: mockModel(['hi', 'hi']), hooks: [hook] });
    const events = await collect(agent.stream('hello'));
    expect(events.map((e) => e.type)).toEqual(expected);
    // No listener: `ctx.emit` is not set, and the run is unaffected.
    expect((await agent.send('hello')).text).toBe('hi');

    // M9: send() with a listener sets it too.
    const heard: AgentEvent[] = [];
    const listening = createAgent({ provider: mockModel(['hi']), hooks: [hook], onEvent: (event) => heard.push(event) });
    expect((await listening.send('hello')).text).toBe('hi');
    expect(heard.map((e) => e.type)).toEqual(expected);
  });

  it('rejects a summarizer together with a strategy, and a threshold outside (0, 1]', () => {
    const strategy: CompactionStrategy = {
      name: 's',
      compact: (input) => ({ messages: input.messages, tokensBefore: 0, tokensAfter: 0, prunedToolCallIds: [] }),
    };
    const provider = mockModel(['x']);
    expect(() => createAgent({ provider, compaction: { strategy, summarizer: 'openai/gpt-4o-mini' } })).toThrow(
      /both 'strategy' and 'summarizer'/
    );
    expect(() => createAgent({ provider, compaction: { thresholdPercent: 2 } })).toThrow(RangeError);
  });

  it('installs nothing for compaction: false', async () => {
    const { agent } = agentWith(false, BIG);
    const events = await collect(agent.stream('read four pages'));
    expect(ofType(events, 'compaction.start')).toEqual([]);
  });
});
