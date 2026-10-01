import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  DEFAULT_SUMMARY_PROMPT,
  compactMessages,
  createCompactionHook,
  isPinned,
  pinMessage,
  pruneToolResultsStrategy,
  summarizeStrategy,
  twoPhaseStrategy,
  type CompactionInfo,
  type CompactionStrategy,
} from './compaction';
import type { Message } from '../providers';
import { estimateTokens } from '../models';
import { HookRegistry } from '../execution/hooks';
import { AgentExecutor } from '../execution/AgentExecutor';
import { defineTool } from '../tools/defineTool';
import { ToolRegistry } from '../tools';
import { mockModel } from '../testing';

const BIG = 'x'.repeat(4_000); // about 1,000 tokens

const call = (id: string, name = 'search') => ({ id, type: 'function' as const, function: { name, arguments: '{}' } });

/** system, user, then `rounds` of assistant tool call + its (large) result. */
function transcript(rounds: number): Message[] {
  const messages: Message[] = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'start' },
  ];
  for (let i = 1; i <= rounds; i++) {
    messages.push({ role: 'assistant', content: '', toolCalls: [call(`call_${i}`)] });
    messages.push({ role: 'tool', toolCallId: `call_${i}`, toolName: 'search', content: `${i}:${BIG}` });
  }
  return messages;
}

/** Every tool call has a later result, and every result answers an earlier call. */
function expectValidTranscript(messages: Message[]): void {
  messages.forEach((message, index) => {
    for (const c of message.toolCalls ?? []) {
      const answer = messages.slice(index + 1).find((m) => m.role === 'tool' && m.toolCallId === c.id);
      expect(answer, `result for ${c.id}`).toBeDefined();
    }
    if (message.role === 'tool') {
      const asked = messages.slice(0, index).some((m) => m.toolCalls?.some((c) => c.id === message.toolCallId));
      expect(asked, `call for ${message.toolCallId}`).toBe(true);
    }
  });
}

const summaryOf = (text: string): Message => ({ role: 'user', content: `[Conversation summary]\n${text}` });

describe('summarizeStrategy', () => {
  it('replaces the prefix with one summary message and keeps the system prompt and the tail intact', async () => {
    const summarizer = mockModel(['The user asked for searches; results 1-8 were read.']);
    const original = transcript(10);
    const result = await compactMessages(original, {
      protectedTokens: 2_100,
      strategy: summarizeStrategy({ model: summarizer, maxSummaryTokens: 500 }),
    });

    // The tail (the last two assistant turns with their results) is the original, untouched.
    expect(result.messages).toEqual([original[0], summaryOf('The user asked for searches; results 1-8 were read.'), ...original.slice(-4)]);
    expect(result.messages[0]).toBe(original[0]);
    result.messages.slice(2).forEach((m, i) => expect(m).toBe(original[original.length - 4 + i]));
    expect(result.summary).toBe('The user asked for searches; results 1-8 were read.');
    expect(result.tokensBefore).toBe(estimateTokens(original));
    expect(result.tokensAfter).toBe(estimateTokens(result.messages));
    expectValidTranscript(result.messages);

    // One focused summary call over the folded messages only.
    expect(summarizer.calls).toHaveLength(1);
    const [request] = summarizer.calls;
    expect(request.maxTokens).toBe(500);
    expect(request.messages[0]).toEqual({ role: 'system', content: DEFAULT_SUMMARY_PROMPT });
    expect(request.messages[1].content).toContain('user: start');
    expect(request.messages[1].content).toContain('[called search({})]');
    expect(request.messages[1].content).toContain('tool search: 8:');
    expect(request.messages[1].content).not.toContain('9:');
    expect(request.messages[1].content).not.toContain('You are helpful.');
  });

  it('keeps an assistant turn and all its tool results together', async () => {
    const original: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [call('a'), call('b')] },
      { role: 'tool', toolCallId: 'a', toolName: 'search', content: BIG },
      { role: 'tool', toolCallId: 'b', toolName: 'search', content: BIG },
      { role: 'assistant', content: '', toolCalls: [call('c')] },
      { role: 'tool', toolCallId: 'c', toolName: 'search', content: 'small' },
    ];
    // 1,100 tokens reach into the middle of the first turn's results; the whole turn is kept.
    const result = await compactMessages(original, {
      protectedTokens: 1_100,
      strategy: summarizeStrategy({ model: mockModel(['S']), prompt: 'Summarize briefly.' }),
    });
    expect(result.messages).toEqual([original[0], summaryOf('S'), ...original.slice(2)]);
    expectValidTranscript(result.messages);
  });

  it('changes nothing when there is nothing before the tail to summarize', async () => {
    const summarizer = mockModel([]);
    const original = transcript(1);
    const result = await compactMessages(original, { protectedTokens: 100_000, strategy: summarizeStrategy({ model: summarizer }) });
    expect(result.messages).toBe(original);
    expect(summarizer.calls).toHaveLength(0);
  });

  it('falls back to pruning and reports the error when the summarizer fails, never throwing', async () => {
    const original = transcript(6);
    const pruned = await compactMessages(original, { protectedTokens: 0 });

    const failing = await compactMessages(original, {
      protectedTokens: 0,
      strategy: summarizeStrategy({ model: mockModel([{ error: new Error('rate limited') }]) }),
    });
    expect(failing.error?.message).toBe('rate limited');
    expect(failing.messages).toEqual(pruned.messages);
    expect(failing.prunedToolCallIds).toEqual(pruned.prunedToolCallIds);
    expect(failing.summary).toBeUndefined();

    const empty = await compactMessages(original, { protectedTokens: 0, strategy: summarizeStrategy({ model: mockModel(['  ']) }) });
    expect(empty.error?.message).toMatch(/empty summary/);
    expect(empty.messages).toEqual(pruned.messages);

    // A model spec that cannot be resolved is a failure too, not a crash.
    const unresolved = await compactMessages(original, { protectedTokens: 0, strategy: summarizeStrategy({ model: 'nosuch/model' }) });
    expect(unresolved.error).toBeInstanceOf(Error);
    expect(unresolved.messages).toEqual(pruned.messages);
  });
});

describe('pinned messages', () => {
  it('pinMessage marks a copy and keeps existing metadata', () => {
    const message: Message = { role: 'user', content: 'hi', metadata: { source: 'ui' } };
    const pinned = pinMessage(message);
    expect(pinned).toEqual({ role: 'user', content: 'hi', metadata: { source: 'ui', pinned: true } });
    expect(isPinned(pinned)).toBe(true);
    expect(isPinned(message)).toBe(false);
  });

  function withPins(): Message[] {
    const messages = transcript(8);
    messages[1] = pinMessage({ role: 'user', content: 'PINNED-GOAL' });
    messages[5] = pinMessage(messages[5]); // call_2's result
    return messages;
  }

  it('are never pruned', async () => {
    const original = withPins();
    const result = await compactMessages(original, { protectedTokens: 0, strategy: pruneToolResultsStrategy() });
    expect(result.messages[5]).toBe(original[5]);
    expect(result.prunedToolCallIds).toEqual(['call_1', 'call_3', 'call_4', 'call_5', 'call_6', 'call_7']);
  });

  it('are never summarized: they stay in place with their tool call, and are not sent to the summarizer', async () => {
    const original = withPins();
    const summarizer = mockModel(['S']);
    const result = await compactMessages(original, { protectedTokens: 0, strategy: summarizeStrategy({ model: summarizer }) });

    // system, pinned user, summary (where call_1 was), call_2's turn with its pinned result, then the tail.
    expect(result.messages).toEqual([original[0], original[1], summaryOf('S'), original[4], original[5], ...original.slice(-2)]);
    expectValidTranscript(result.messages);
    const sent = summarizer.calls[0].messages[1].content;
    expect(sent).not.toContain('PINNED-GOAL');
    expect(sent).not.toContain('2:');
    expect(sent).toContain('1:');
    expect(sent).toContain('7:');
  });

  it('survive the two-phase strategy', async () => {
    const original = withPins();
    const result = await compactMessages(original, {
      protectedTokens: 0,
      contextWindow: 1_000,
      strategy: twoPhaseStrategy({ model: mockModel(['S']) }),
    });
    expect(result.summary).toBe('S');
    expect(result.messages.filter(isPinned)).toEqual([original[1], original[5]]);
    expectValidTranscript(result.messages);
  });
});

describe('twoPhaseStrategy', () => {
  it('only prunes when pruning gets under the threshold', async () => {
    const summarizer = mockModel([]);
    const original = transcript(10);
    // ~10,100 tokens; pruning all but the last result leaves ~1,200, under 90% of 2,000.
    const result = await compactMessages(original, {
      protectedTokens: 0,
      contextWindow: 2_000,
      strategy: twoPhaseStrategy({ model: summarizer }),
    });
    expect(summarizer.calls).toHaveLength(0);
    expect(result.summary).toBeUndefined();
    expect(result.prunedToolCallIds).toHaveLength(9);
    expect(result.tokensAfter).toBeLessThan(1_800);
  });

  it('summarizes the pruned conversation when pruning is not enough', async () => {
    const summarizer = mockModel(['S']);
    const original = transcript(10);
    const result = await compactMessages(original, {
      protectedTokens: 0,
      contextWindow: 1_000,
      strategy: twoPhaseStrategy({ model: summarizer }),
    });
    expect(result.prunedToolCallIds).toHaveLength(9);
    expect(result.summary).toBe('S');
    expect(result.tokensBefore).toBe(estimateTokens(original));
    expect(result.messages).toEqual([original[0], summaryOf('S'), ...original.slice(-2)]);
    // The summarizer read the pruned results, not the full ones.
    expect(summarizer.calls[0].messages[1].content).toContain('[pruned: search result');
    expect(summarizer.calls[0].messages[1].content).not.toContain(BIG);
  });

  it('keeps the pruned result and reports the error when the summarizer fails', async () => {
    const original = transcript(10);
    const result = await compactMessages(original, {
      protectedTokens: 0,
      contextWindow: 1_000,
      strategy: twoPhaseStrategy({ model: mockModel([{ error: new Error('down') }]) }),
    });
    expect(result.error?.message).toBe('down');
    expect(result.prunedToolCallIds).toHaveLength(9);
    expect(result.tokensBefore).toBe(estimateTokens(original));
    expect(result.messages).toHaveLength(original.length);
    expectValidTranscript(result.messages);
  });
});

describe('async strategies in the hook', () => {
  async function runHook(strategy: CompactionStrategy, onCompaction: (info: CompactionInfo) => void) {
    const hooks = new HookRegistry();
    hooks.register(createCompactionHook({ strategy, contextWindow: 1_000, protectedTokens: 0, onCompaction }));
    const messages = transcript(4);
    await hooks.runPreGenerate({ messages, request: { messages } });
    return messages;
  }

  it('reports the summary, and reports a fallback error without throwing', async () => {
    const infos: CompactionInfo[] = [];
    const summarized = await runHook(summarizeStrategy({ model: mockModel(['S']) }), (info) => infos.push(info));
    expect(summarized[1]).toEqual(summaryOf('S'));
    expect(infos[0]).toMatchObject({ strategy: 'summarize', summary: 'S' });
    expect(infos[0].error).toBeUndefined();

    const fellBack = await runHook(summarizeStrategy({ model: mockModel([{ error: new Error('boom') }]) }), (info) => infos.push(info));
    expect(fellBack.some((m) => m.content.startsWith('[pruned: '))).toBe(true);
    expect(infos[1]).toMatchObject({ strategy: 'summarize', prunedToolCallIds: ['call_1', 'call_2', 'call_3'] });
    expect(infos[1].error?.message).toBe('boom');
  });

  it('leaves the run alone and reports the error when a strategy throws', async () => {
    const onCompaction = vi.fn<(info: CompactionInfo) => void>();
    const throwing: CompactionStrategy = { name: 'broken', compact: async () => Promise.reject(new Error('bad strategy')) };
    const messages = await runHook(throwing, onCompaction);
    expect(messages).toEqual(transcript(4));
    expect(onCompaction).toHaveBeenCalledTimes(1);
    expect(onCompaction.mock.calls[0][0]).toMatchObject({ strategy: 'broken', prunedToolCallIds: [] });
    expect(onCompaction.mock.calls[0][0].error?.message).toBe('bad strategy');
  });
});

describe('summarize compaction in a run', () => {
  it('summarizes old turns before a model call and keeps the summary in the transcript', async () => {
    const fetchPage = defineTool({
      name: 'fetch_page',
      description: 'Fetch a page',
      input: z.object({ n: z.number() }),
      execute: async ({ n }) => `${n}:${BIG}`,
    });
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(fetchPage);
    const fetchCall = (n: number) => ({ toolCalls: [{ name: 'fetch_page', args: { n }, id: `call_${n}` }] });
    const model = mockModel([fetchCall(1), fetchCall(2), fetchCall(3), fetchCall(4), 'done']);
    const summarizer = mockModel(['Read pages 1 and 2.'], { onExhausted: 'repeat-last' });

    const compactions: CompactionInfo[] = [];
    const hooks = new HookRegistry();
    hooks.register(
      createCompactionHook({
        contextWindow: 3_000,
        protectedTokens: 1_500,
        strategy: summarizeStrategy({ model: summarizer }),
        onCompaction: (info) => compactions.push(info),
      })
    );

    const result = await AgentExecutor.execute({
      agent: { id: 'a', name: 'Agent', prompt: 'Read pages.', tools: { fetch_page: { tool: 'fetch_page' } } },
      input: 'read four pages',
      provider: model,
      toolRegistry,
      hooks,
      maxSteps: 10,
    });

    expect(result.text).toBe('done');
    expect(compactions).toHaveLength(1);
    expect(compactions[0]).toMatchObject({ strategy: 'summarize', summary: 'Read pages 1 and 2.' });
    expect(summarizer.calls).toHaveLength(1);
    expect(summarizer.calls[0].messages[1].content).toContain('user: read four pages');

    // The 4th model call is the first to see the summary; every request stays valid and under the threshold.
    const summary = summaryOf('Read pages 1 and 2.');
    expect(model.calls[3].messages[1]).toEqual(summary);
    for (const req of model.calls) {
      expectValidTranscript(req.messages as Message[]);
      expect(estimateTokens(req.messages as Message[])).toBeLessThan(3_000 * 0.9);
    }
    // The summary persists in the run's transcript, after the system prompt.
    expect(result.messages[1]).toEqual(summary);
    expect(result.messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId)).toEqual(['call_3', 'call_4']);
    expectValidTranscript(result.messages);
  });
});
