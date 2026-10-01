import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  compactMessages,
  createCompactionHook,
  pruneToolResultsStrategy,
  type CompactionInfo,
  type CompactionStrategy,
} from './compaction';
import type { GenerateOptions, Message } from '../providers';
import { estimateTokens, registerModel } from '../models';
import { HookRegistry } from '../execution/hooks';
import { AgentExecutor } from '../execution/AgentExecutor';
import { defineTool } from '../tools/defineTool';
import { ToolRegistry } from '../tools';
import { mockModel } from '../testing';

const BIG = 'x'.repeat(4_000); // about 1,000 tokens

/** system, user, then `rounds` of assistant tool call + its (large) result. */
function transcript(rounds: number, firstUser = 'start'): Message[] {
  const messages: Message[] = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: firstUser },
  ];
  for (let i = 1; i <= rounds; i++) {
    const id = `call_${i}`;
    messages.push({
      role: 'assistant',
      content: '',
      toolCalls: [{ id, type: 'function', function: { name: 'search', arguments: '{}' } }],
    });
    messages.push({ role: 'tool', toolCallId: id, toolName: 'search', content: `${i}:${BIG}` });
  }
  return messages;
}

const isMarker = (m: Message) => /^\[pruned: search result, \d+ chars\]$/.test(m.content);

/** Every assistant tool call is followed by a tool message answering it. */
function expectValidTranscript(messages: Message[]): void {
  messages.forEach((message, index) => {
    for (const call of message.toolCalls ?? []) {
      const answer = messages.slice(index + 1).find((m) => m.role === 'tool' && m.toolCallId === call.id);
      expect(answer, `result for ${call.id}`).toBeDefined();
    }
  });
}

describe('pruneToolResultsStrategy / compactMessages', () => {
  it('replaces old tool results with a marker and keeps the protected tail intact and in order', async () => {
    const original = transcript(10);
    const result = await compactMessages(original, { protectedTokens: 3_000, strategy: pruneToolResultsStrategy() });

    expect(result.messages).toHaveLength(original.length);
    expect(result.messages.map((m) => m.role)).toEqual(original.map((m) => m.role));
    expect(result.messages.map((m) => m.toolCallId)).toEqual(original.map((m) => m.toolCallId));

    const firstKept = result.messages.findIndex((m, i) => i > 1 && m === original[i] && m.role === 'tool');
    // Everything from the first kept result on is the original tail, untouched and in order...
    expect(result.messages.slice(firstKept)).toEqual(original.slice(firstKept));
    expect(estimateTokens(original.slice(firstKept + 1))).toBeLessThanOrEqual(3_000);
    // ...and every older result is a marker.
    const older = result.messages.slice(0, firstKept).filter((m) => m.role === 'tool');
    expect(older.length).toBeGreaterThan(0);
    expect(older.every(isMarker)).toBe(true);
    expect(result.prunedToolCallIds).toEqual(older.map((m) => m.toolCallId));
    expect(result.messages[3].content).toBe(`[pruned: search result, ${original[3].content.length} chars]`);

    expect(result.tokensBefore).toBe(estimateTokens(original));
    expect(result.tokensAfter).toBe(estimateTokens(result.messages));
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore / 2);
    expectValidTranscript(result.messages);
  });

  it('never touches system messages, user messages or assistant turns', async () => {
    const original = transcript(4, BIG);
    original.splice(4, 0, { role: 'user', content: BIG });
    const result = await compactMessages(original, { protectedTokens: 0 });

    result.messages.forEach((m, i) => {
      if (m.role !== 'tool') expect(m).toBe(original[i]);
    });
    expect(result.prunedToolCallIds).toEqual(['call_1', 'call_2', 'call_3']);
  });

  it('never prunes results of the latest assistant turn, even with no protected tokens', async () => {
    const original = transcript(3);
    const result = await compactMessages(original, { protectedTokens: 0 });
    expect(result.messages.at(-1)).toBe(original.at(-1));
    expect(result.prunedToolCallIds).toEqual(['call_1', 'call_2']);
  });

  it('is pure and idempotent: markers and short results are left alone', async () => {
    const original = transcript(5);
    original.push({ role: 'assistant', content: '', toolCalls: [{ id: 'tiny', type: 'function', function: { name: 'n', arguments: '{}' } }] });
    original.push({ role: 'tool', toolCallId: 'tiny', toolName: 'n', content: '"ok"' });
    original.push({ role: 'assistant', content: 'done' });
    const snapshot = structuredClone(original);

    const first = await compactMessages(original, { protectedTokens: 0 });
    expect(original).toEqual(snapshot);
    expect(first.prunedToolCallIds).toEqual(['call_1', 'call_2', 'call_3', 'call_4', 'call_5']);

    const second = await compactMessages(first.messages, { protectedTokens: 0 });
    expect(second.messages).toBe(first.messages);
    expect(second.prunedToolCallIds).toEqual([]);
    expect(second.tokensAfter).toBe(second.tokensBefore);
  });

  it('uses the given strategy', async () => {
    const strategy: CompactionStrategy = {
      name: 'drop-all',
      compact: ({ messages, estimateTokens: count, contextWindow }) => ({
        messages: messages.slice(0, 2),
        tokensBefore: count(messages),
        tokensAfter: contextWindow,
        prunedToolCallIds: [],
      }),
    };
    const result = await compactMessages(transcript(2), { strategy, model: 'gpt-4o-mini' });
    expect(result.messages).toHaveLength(2);
    expect(result.tokensAfter).toBe(128_000); // gpt-4o-mini's window from the registry
  });
});

function request(messages: Message[], model = 'compaction-test-model'): GenerateOptions {
  return { model, messages };
}

describe('createCompactionHook', () => {
  registerModel({ id: 'compaction-test-model', provider: 'test', contextWindow: 10_000 });

  async function runHook(hook = createCompactionHook(), req = request(transcript(10))) {
    const hooks = new HookRegistry();
    hooks.register(hook);
    const before = req.messages;
    await hooks.runPreGenerate({ messages: req.messages, request: req });
    expect(req.messages).toBe(before); // rewritten in place, never replaced
    return req;
  }

  it('is named compaction and rejects a threshold outside (0, 1]', () => {
    expect(createCompactionHook().name).toBe('compaction');
    expect(() => createCompactionHook({ thresholdPercent: 0 })).toThrow(RangeError);
    expect(() => createCompactionHook({ thresholdPercent: 1.5 })).toThrow(RangeError);
  });

  it('compacts only above thresholdPercent of the context window', async () => {
    const messages = transcript(4);
    const tokens = estimateTokens(messages);
    const onCompaction = vi.fn();

    // Exactly at the threshold: nothing happens.
    const atThreshold = await runHook(
      createCompactionHook({ contextWindow: tokens * 2, thresholdPercent: 0.5, protectedTokens: 0, onCompaction }),
      request(structuredClone(messages))
    );
    expect(atThreshold.messages).toEqual(messages);
    expect(onCompaction).not.toHaveBeenCalled();

    // One token over: compacts.
    const over = await runHook(
      createCompactionHook({ contextWindow: (tokens - 1) * 2, thresholdPercent: 0.5, protectedTokens: 0, onCompaction }),
      request(structuredClone(messages))
    );
    expect(over.messages.filter(isMarker)).toHaveLength(3);
    expect(onCompaction).toHaveBeenCalledTimes(1);
  });

  it('uses the registry context window for request.model and the default 0.9 threshold', async () => {
    // compaction-test-model has a 10,000-token window: 8 rounds (~8,100 tokens) stay, 10 (~10,100) compact.
    const onCompaction = vi.fn<(info: CompactionInfo) => void>();
    const small = await runHook(createCompactionHook({ protectedTokens: 2_000, onCompaction }), request(transcript(8)));
    expect(small.messages.some(isMarker)).toBe(false);

    const large = await runHook(createCompactionHook({ protectedTokens: 2_000, onCompaction }), request(transcript(10)));
    expect(large.messages.filter(isMarker).length).toBeGreaterThan(5);
    expectValidTranscript(large.messages);

    const info = onCompaction.mock.calls[0][0];
    expect(info.strategy).toBe('prune-tool-results');
    expect(info.tokensBefore).toBeGreaterThan(9_000);
    expect(info.tokensAfter).toBe(estimateTokens(large.messages));
    expect(info.prunedToolCallIds).toEqual(large.messages.filter(isMarker).map((m) => m.toolCallId));

    // An unknown model falls back to a 128,000-token window.
    const unknown = await runHook(createCompactionHook({ protectedTokens: 0 }), request(transcript(10), 'no-such-model'));
    expect(unknown.messages.some(isMarker)).toBe(false);
  });

  it('does not report a compaction that changed nothing', async () => {
    const onCompaction = vi.fn();
    const hook = createCompactionHook({ contextWindow: 100, protectedTokens: 0, onCompaction });
    const req = await runHook(hook);
    await runHook(hook, req);
    expect(onCompaction).toHaveBeenCalledTimes(1);
  });
});

describe('compaction in a run', () => {
  it('prunes old tool results before each model call and keeps them pruned in the transcript', async () => {
    const fetchPage = defineTool({
      name: 'fetch_page',
      description: 'Fetch a page',
      input: z.object({ n: z.number() }),
      execute: async ({ n }) => `${n}:${BIG}`,
    });
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(fetchPage);
    const call = (n: number) => ({ toolCalls: [{ name: 'fetch_page', args: { n }, id: `call_${n}` }] });
    const model = mockModel([call(1), call(2), call(3), call(4), 'done']);

    const compactions: CompactionInfo[] = [];
    const hooks = new HookRegistry();
    hooks.register(
      createCompactionHook({ contextWindow: 3_000, protectedTokens: 1_500, onCompaction: (info) => compactions.push(info) })
    );

    const result = await AgentExecutor.execute({
      agent: {
        id: 'a',
        name: 'Agent',
        prompt: 'Read pages.',
        tools: { fetch_page: { tool: 'fetch_page' } },
      },
      input: 'read four pages',
      provider: model,
      toolRegistry,
      hooks,
      maxSteps: 10,
    });

    expect(result.text).toBe('done');
    // Each request stays under the threshold once compacted; the newest result is always intact.
    for (const req of model.calls.slice(1)) {
      expect(estimateTokens(req.messages as Message[])).toBeLessThan(3_000 * 0.9);
      expect(req.messages.at(-1)?.content).toContain(BIG);
    }
    // Pruning persists in the run's transcript, and no result is pruned twice.
    const pruned = compactions.flatMap((c) => c.prunedToolCallIds);
    expect(new Set(pruned).size).toBe(pruned.length);
    expect(pruned).toEqual(['call_1', 'call_2']); // call_3 and call_4 fit under the threshold
    const markers = result.messages.filter((m) => m.role === 'tool' && m.content.startsWith('[pruned: fetch_page result'));
    expect(markers.map((m) => m.toolCallId)).toEqual(pruned);
    expectValidTranscript(result.messages);
  });
});
