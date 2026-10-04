/**
 * LOU-341: a tool that returns nothing has the result `null`, so the
 * transcript's `tool` message never has `content: undefined`.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockTurn } from '../testing';
import { memoryStore } from '../storage/agentStore';
import type { Message } from '../providers';
import { toolResultContent } from './toolResult';
import { withToolResult } from './fork';

const call = (name: string, args: Record<string, unknown>, id: string): MockTurn => ({ toolCalls: [{ name, args, id }] });
// mockModel deep-freezes what the provider saw, so calls[i].messages is deeply readonly - not Message[].
const toolContents = (messages: readonly { readonly role: string; readonly content: unknown }[]) =>
  messages.filter((m) => m.role === 'tool').map((m) => m.content);

const nothing = (extra: { needsApproval?: boolean } = {}) =>
  defineTool({ name: 'nothing', description: 'Returns undefined', input: z.object({}), ...extra, execute: async () => undefined });

const emptyGenerator = () =>
  defineTool({
    name: 'quiet',
    description: 'Yields nothing',
    input: z.object({}),
    async *execute() {
      return 'ignored';
    },
  });

describe('a tool that returns nothing (LOU-341)', () => {
  it('toolResultContent() is always a string', () => {
    expect(toolResultContent(undefined)).toBe('null');
    expect(toolResultContent(() => 1)).toBe('null');
    expect(toolResultContent({ a: 1 })).toBe('{"a":1}');
  });

  it('a plain tool returning undefined: the transcript and the next model request carry "null"', async () => {
    const model = mockModel([call('nothing', {}, 'call_1'), 'Done.']);
    const agent = createAgent({ provider: model, tools: [nothing()] });

    const result = await agent.send('Go.');

    expect(toolContents(result.messages)).toEqual(['null']);
    expect(toolContents(model.calls[1].messages)).toEqual(['null']);
  });

  it('an async generator that yields nothing agrees with a plain undefined', async () => {
    const model = mockModel([call('quiet', {}, 'call_1'), 'Done.']);
    const agent = createAgent({ provider: model, tools: [emptyGenerator()] });

    const result = await agent.send('Go.');

    expect(toolContents(result.messages)).toEqual(['null']);
  });

  it('after an approval resume the result is "null" too, and the stored checkpoint round-trips', async () => {
    const store = memoryStore();
    const model = mockModel([call('nothing', {}, 'call_1'), 'Done.']);
    const agent = createAgent({ provider: model, tools: [nothing({ needsApproval: true })], store });

    const paused = await agent.send('Go.');
    expect(paused.finishReason).toBe('awaiting-approval');
    const resumed = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(toolContents(resumed.messages)).toEqual(['null']);
    expect(JSON.parse(JSON.stringify(resumed.messages))).toEqual(resumed.messages);
  });

  it('a forked transcript with an undefined patched result gets "null"', () => {
    const messages: Message[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'nothing', arguments: '{}' } }] },
    ];
    expect(toolContents(withToolResult(messages, { toolCallId: 'c1', result: undefined }))).toEqual(['null']);
  });
});
