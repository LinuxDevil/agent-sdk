/**
 * Audit C4: a rejected summary is retried once the transcript has grown, the
 * summarizer's call is counted in the run (usage, span, budgets), the events
 * report the strategy that ran and the one applied, `createAgent({ compaction })`
 * takes `onCompaction`, and pruned results leave a stub naming the call.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import type { Message } from '../providers';
import { textOf } from '../providers';
import { defineTool } from '../tools/defineTool';
import { HookRegistry } from '../execution/hooks';
import type { AgentEvent, AgentEventOf } from '../execution';
import { mockModel } from '../testing';
import { compactMessages, createCompactionHook, summarizeStrategy, type CompactionInfo } from './compaction';

const BIG = 'x'.repeat(4_000); // about 1,000 tokens

const fetchPage = defineTool({
  name: 'fetch_page',
  description: 'Fetch a page',
  input: z.object({ n: z.number() }),
  execute: async ({ n }) => `${n}:${BIG}`,
});
const fetchCall = (n: number) => ({ toolCalls: [{ name: 'fetch_page', args: { n }, id: `call_${n}` }] });
const usage = (inputTokens: number, outputTokens: number) => ({ usage: { inputTokens, outputTokens } });
const fourPages = (spent?: ReturnType<typeof usage>) =>
  [fetchCall(1), fetchCall(2), fetchCall(3), fetchCall(4), { text: 'done' }].map((turn) => ({ ...turn, ...spent }));

function transcript(rounds: number): Message[] {
  const messages: Message[] = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'start' },
  ];
  for (let i = 1; i <= rounds; i++) {
    messages.push({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: `call_${i}`, type: 'function', function: { name: 'search', arguments: `{"query":"q${i}"}` } }],
    });
    messages.push({ role: 'tool', toolCallId: `call_${i}`, toolName: 'search', content: `${i}:${BIG}` });
  }
  return messages;
}

const ofType = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is AgentEventOf<T> => e.type === type);

describe('a rejected summary is retried once the transcript has grown (C4a)', () => {
  it('prunes only while the transcript is small, then summarizes again once it has doubled', async () => {
    const summarizer = mockModel([BIG], { onExhausted: 'repeat-last' });
    const infos: CompactionInfo[] = [];
    const hooks = new HookRegistry();
    hooks.register(
      createCompactionHook({
        strategy: summarizeStrategy({ model: summarizer }),
        contextWindow: 1_000,
        protectedTokens: 0,
        onCompaction: (info) => infos.push(info),
      })
    );
    const messages = transcript(2); // 6 messages
    await hooks.runPreGenerate({ messages, request: { messages } });
    expect(summarizer.calls).toHaveLength(1);
    expect(infos[0].error?.message).toMatch(/did not compact/);

    // One more turn: not enough new content, still prune-only.
    messages.push(...transcript(3).slice(6));
    await hooks.runPreGenerate({ messages, request: { messages } });
    expect(summarizer.calls).toHaveLength(1);

    // Twice the messages of the rejection: the summarizer gets another chance.
    messages.push(...transcript(5).slice(8));
    expect(messages).toHaveLength(12);
    await hooks.runPreGenerate({ messages, request: { messages } });
    expect(summarizer.calls).toHaveLength(2);
  });
});

describe('the summarizer call is part of the run (C4b)', () => {
  it('adds its usage to result.usage (byModel, modelCalls) and gives it a chat span tagged compaction', async () => {
    const model = mockModel(fourPages(usage(100, 10)));
    const summarizer = mockModel([{ text: 'Read pages 1 and 2.', ...usage(3_000, 400) }], { onExhausted: 'repeat-last', defaultModel: 'summarizer-model' });
    const spans: Array<{ name: string; attributes: Record<string, unknown> }> = [];
    const agent = createAgent({
      provider: model,
      tools: [fetchPage],
      maxSteps: 10,
      exporter: { onSpanStart: () => {}, onSpanEnd: (span) => spans.push({ name: span.name, attributes: { ...span.attributes } }) },
      compaction: { contextWindow: 3_000, protectedTokens: 1_500, strategy: summarizeStrategy({ model: summarizer }) },
    });
    const result = await agent.send('read four pages');

    expect(result.text).toBe('done');
    expect(summarizer.calls).toHaveLength(1);
    expect(result.usage.modelCalls).toBe(model.calls.length + 1);
    expect(result.usage.byModel['summarizer-model']).toMatchObject({ inputTokens: 3_000, outputTokens: 400, calls: 1 });
    expect(result.usage.inputTokens).toBe(model.calls.length * 100 + 3_000);
    const compactionSpans = spans.filter((span) => span.attributes['lousho.call.purpose'] === 'compaction');
    expect(compactionSpans).toHaveLength(1);
    expect(compactionSpans[0].name).toMatch(/^chat/);
  });

  it('counts toward the run budgets', async () => {
    const agent = createAgent({
      provider: mockModel(fourPages(usage(100, 10))),
      tools: [fetchPage],
      maxSteps: 10,
      limits: { maxTokens: 2_000 },
      compaction: {
        contextWindow: 3_000,
        protectedTokens: 1_500,
        strategy: summarizeStrategy({ model: mockModel([{ text: 'S', ...usage(3_000, 400) }], { onExhausted: 'repeat-last' }) }),
      },
    });
    const result = await agent.send('read four pages');
    expect(result.finishReason).toBe('budget-exceeded');
  });
});

describe('compaction events and options (C4c, C4d)', () => {
  it('compaction.start and compaction.done name the same strategy; done adds appliedStrategy when the summary was rejected', async () => {
    const summarizer = mockModel(['x'.repeat(20_000)], { onExhausted: 'repeat-last' });
    const infos: CompactionInfo[] = [];
    // Big assistant texts cannot be pruned, so two-phase has to summarize.
    const wordy = (n: number) => ({ text: BIG, toolCalls: [{ name: 'fetch_page', args: { n }, id: `call_${n}` }] });
    const agent = createAgent({
      provider: mockModel([wordy(1), wordy(2), wordy(3), wordy(4), 'done']),
      tools: [fetchPage],
      maxSteps: 10,
      compaction: { contextWindow: 3_000, protectedTokens: 1_000, thresholdPercent: 0.5, summarizer, onCompaction: (info) => infos.push(info) },
    });
    const events: AgentEvent[] = [];
    const run = agent.stream('read four pages');
    for await (const event of run) events.push(event);
    await run.result;

    const starts = ofType(events, 'compaction.start');
    const dones = ofType(events, 'compaction.done');
    expect(dones.length).toBeGreaterThan(0);
    dones.forEach((done, i) => expect(done.strategy).toBe(starts[i].strategy));
    const rejected = dones.find((done) => done.error?.message.includes('did not compact'));
    expect(rejected).toMatchObject({ strategy: 'two-phase', appliedStrategy: 'prune-tool-results' });
    // The object form passes onCompaction through.
    expect(infos.find((info) => info.error)?.appliedStrategy).toBe('prune-tool-results');
  });

  it('onCompaction in the object form receives the summary text', async () => {
    const infos: CompactionInfo[] = [];
    const agent = createAgent({
      provider: mockModel(fourPages()),
      tools: [fetchPage],
      maxSteps: 10,
      compaction: {
        contextWindow: 3_000,
        protectedTokens: 1_500,
        strategy: summarizeStrategy({ model: mockModel(['Read pages 1 and 2.'], { onExhausted: 'repeat-last' }) }),
        onCompaction: (info) => infos.push(info),
      },
    });
    await agent.send('read four pages');
    expect(infos.map((info) => info.summary)).toContain('Read pages 1 and 2.');
  });
});

describe('pruned results leave a stub naming the call (C4e)', () => {
  it('names the tool and its arguments and says the result was already seen', async () => {
    const { messages } = await compactMessages(transcript(3), { protectedTokens: 0, contextWindow: 100_000 });
    const stub = textOf(messages[3]);
    expect(stub).toMatch(/^\[pruned: search\(\{"query":"q1"\}\) result, \d+ chars/);
    expect(stub).toMatch(/already/);
    expect(stub.length).toBeLessThan(200);

    // Idempotent: a stub is not pruned again.
    const again = await compactMessages(messages, { protectedTokens: 0, contextWindow: 100_000 });
    expect(again.prunedToolCallIds).toEqual([]);

    // Long arguments are cut short.
    const long = transcript(2);
    long[2].toolCalls![0].function.arguments = JSON.stringify({ query: 'y'.repeat(1_000) });
    const cut = await compactMessages(long, { protectedTokens: 0, contextWindow: 100_000 });
    expect(textOf(cut.messages[3]).length).toBeLessThan(300);
  });
});
