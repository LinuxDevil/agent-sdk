/**
 * N1a: hosted tool calls in the run loop, driven by `mockModel` hosted turns:
 * mockModel itself (generate and stream), events on both paths, the
 * transcript cap, usage (also rolled up from a sub-agent), the finish-reason
 * rule, traces, the fingerprint, and that sub-agents do not inherit the
 * lead's hosted tools.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { codeInterpreter, fileSearch, hostedTool, webSearch } from '../tools/hosted';
import { hostedToolsInMode } from './permissions';
import { mockModel } from '../testing';
import type { StreamChunk } from '../providers';
import type { AgentEvent } from './agentEvents';
import { HOSTED_RESULT_LIMIT, cappedHostedResult, settleHostedFinish } from './hostedToolCalls';
import { fingerprintOf } from './agentFingerprint';
import { AgentBuilder } from '../core/AgentBuilder';
import type { Span, TraceExporter } from './tracing';
import { emptyRunUsage, mergeDelegatedUsage, usageSince } from './runUsage';
import { withFallback, withRetry } from '../providers/resilience';
import { recordReplay } from '../testing/recordReplay';
import { toUIMessageStream } from '../server/uiMessageStream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

afterEach(() => {
  vi.restoreAllMocks();
});

const search = { name: 'web_search', id: 'ws_1', args: { query: 'q' }, result: { hits: 2 }, sources: [{ url: 'https://lousho.com', title: 'Lousho' }] };

describe('mockModel hosted turns', () => {
  it('generate() returns the scripted hosted calls and records hostedTools on the call', async () => {
    const model = mockModel([{ text: 'answer', hostedToolCalls: [search, { name: 'code_interpreter', args: { code: '1+1' }, result: 2 }] }]);
    const result = await model.generate({ messages: [{ role: 'user', content: 'hi' }], hostedTools: [webSearch(), codeInterpreter()] });
    expect(result.finishReason).toBe('stop');
    expect(result.toolCalls).toBeUndefined();
    expect(result.hostedToolCalls).toEqual([
      { id: 'ws_1', name: 'web_search', args: { query: 'q' }, result: { hits: 2 }, sources: [{ url: 'https://lousho.com', title: 'Lousho' }] },
      { id: 'hosted_1', name: 'code_interpreter', args: { code: '1+1' }, result: 2 },
    ]);
    expect(model.lastCall?.hostedTools?.map((tool) => tool.name)).toEqual(['web_search', 'code_interpreter']);
    expect(model.supportsHostedTool?.('web_search')).toBe(true);
  });

  it('stream() yields each hosted call, then its result, before the text', async () => {
    const model = mockModel([{ text: 'answer', hostedToolCalls: [search] }]);
    const streamed = await model.stream({ messages: [{ role: 'user', content: 'hi' }] });
    const chunks: StreamChunk[] = [];
    for await (const chunk of streamed.fullStream) chunks.push(chunk);
    expect(chunks.map((chunk) => chunk.type)).toEqual(['hosted-tool-call', 'hosted-tool-result', 'text-delta', 'finish']);
    expect(chunks[0]!.hostedToolCall).toEqual({ id: 'ws_1', name: 'web_search', args: { query: 'q' } });
    expect(chunks[1]!.hostedToolCall).toEqual(search);
  });
});

function agentWith(turns: Parameters<typeof mockModel>[0]) {
  const execute = vi.fn(async () => 'ran');
  const lookup = defineTool({ name: 'lookup', description: 'Look up', input: z.object({}), execute });
  const events: AgentEvent[] = [];
  const model = mockModel(turns);
  const agent = createAgent({ provider: model, instructions: 'x', tools: [webSearch(), lookup], onEvent: (event) => events.push(event) });
  return { agent, events, execute, model };
}

describe('hosted calls in a run (mockModel)', () => {
  it('a hosted call next to a local call: only the local one runs; both are reported in order', async () => {
    const { agent, events, execute, model } = agentWith([
      { text: 'Searching.', hostedToolCalls: [search], toolCalls: [{ name: 'lookup', id: 'call_l' }] },
      'Done.',
    ]);
    const result = await agent.send('go');
    expect(execute).toHaveBeenCalledTimes(1);
    const tools = events.filter((event) => event.type === 'tool.start').map((event) => [event.toolName, 'executedBy' in event ? event.executedBy : undefined]);
    expect(tools).toEqual([
      ['web_search', 'provider'],
      ['lookup', undefined],
    ]);
    // The tool-call turn carries the hosted call; the provider sees only the local call back.
    const turn = result.messages.find((m) => m.role === 'assistant' && m.toolCalls?.length);
    expect(turn?.metadata?.hostedToolCalls).toEqual([search]);
    expect(turn?.toolCalls?.map((call) => call.function.name)).toEqual(['lookup']);
    expect(model.calls[1]!.messages.some((m) => m.toolCalls?.some((call) => call.function.name === 'web_search'))).toBe(false);
    expect(result.usage.hostedToolCalls).toEqual({ web_search: 1 });
  });

  it('send() without listeners keeps the metadata and usage, and emits nothing', async () => {
    const model = mockModel([{ text: 'answer', hostedToolCalls: [search, search] }]);
    const result = await createAgent({ provider: model, instructions: 'x', tools: [webSearch()] }).send('go');
    expect(result.messages.at(-1)?.metadata?.hostedToolCalls).toHaveLength(2);
    expect(result.usage.hostedToolCalls).toEqual({ web_search: 2 });
  });

  it('a hosted call with no result still ends with tool.done (result null)', async () => {
    const { agent, events } = agentWith([{ text: 'answer', hostedToolCalls: [{ name: 'web_search', id: 'ws_9' }] }]);
    await agent.send('go');
    expect(events.find((event) => event.type === 'tool.done')).toMatchObject({ toolCallId: 'ws_9', result: null, executedBy: 'provider' });
  });

  it('large results are capped at 20,000 characters of JSON in events and the transcript', async () => {
    const big = { text: 'x'.repeat(HOSTED_RESULT_LIMIT + 500) };
    const { agent, events } = agentWith([{ text: 'answer', hostedToolCalls: [{ name: 'web_search', id: 'ws_big', result: big }] }]);
    const result = await agent.send('go');
    const kept = (result.messages.at(-1)?.metadata?.hostedToolCalls as Array<{ result: unknown }>)[0]!.result;
    expect(typeof kept).toBe('string');
    expect(kept as string).toMatch(/\.\.\. \[truncated 51\d characters\]$/);
    expect((kept as string).length).toBeLessThan(HOSTED_RESULT_LIMIT + 50);
    expect(events.find((event) => event.type === 'tool.done')).toMatchObject({ result: kept });
    expect(cappedHostedResult({ a: 1 })).toEqual({ a: 1 });
  });

  it('settleHostedFinish(): tool_calls with only hosted calls is a final reply', () => {
    const hostedToolCalls = [{ id: 'a', name: 'web_search', args: {} }];
    expect(settleHostedFinish({ text: '', finishReason: 'tool_calls', hostedToolCalls }).finishReason).toBe('stop');
    const local = { id: 'c', type: 'function' as const, function: { name: 'x', arguments: '{}' } };
    expect(settleHostedFinish({ text: '', finishReason: 'tool_calls', hostedToolCalls, toolCalls: [local] }).finishReason).toBe('tool_calls');
    expect(settleHostedFinish({ text: '', finishReason: 'tool_calls' }).finishReason).toBe('tool_calls');
  });

  it('a step with only hosted calls and finish reason tool_calls ends the run after one model call', async () => {
    const { agent, model, events } = agentWith([{ text: 'answer', hostedToolCalls: [search], finishReason: 'tool_calls' }]);
    const result = await agent.send('go');
    expect(result.finishReason).toBe('stop');
    expect(model.calls).toHaveLength(1);
    expect(events.find((event) => event.type === 'step.done')).toMatchObject({ finishReason: 'stop' });
  });

  it('the chat span names the hosted calls; there is no execute_tool span for them', async () => {
    const spans: Span[] = [];
    const exporter: TraceExporter = { onSpanStart: (span) => spans.push(span), onSpanEnd: () => undefined };
    const model = mockModel([{ text: 'answer', hostedToolCalls: [search] }]);
    await createAgent({ provider: model, instructions: 'x', tools: [webSearch()], exporter }).send('go');
    const chat = spans.find((span) => span.attributes['gen_ai.operation.name'] === 'chat');
    expect(chat?.attributes['lousho.hosted_tool_calls']).toEqual(['web_search']);
    expect(spans.some((span) => span.attributes['gen_ai.operation.name'] === 'execute_tool')).toBe(false);
  });
});

describe('hosted calls in usage', () => {
  it('a delegated child adds its counts; usageSince subtracts them', () => {
    const lead = emptyRunUsage();
    lead.hostedToolCalls = { web_search: 1 };
    const child = emptyRunUsage();
    child.hostedToolCalls = { web_search: 2, code_interpreter: 1 };
    mergeDelegatedUsage(lead, child);
    expect(lead.hostedToolCalls).toEqual({ web_search: 3, code_interpreter: 1 });
    expect(usageSince(lead, { ...emptyRunUsage(), hostedToolCalls: { web_search: 3 } }).hostedToolCalls).toEqual({ code_interpreter: 1 });
  });
});

describe('sub-agents and resume', () => {
  it('a sub-agent does not inherit the lead hosted tools', async () => {
    const childModel = mockModel(['child answer']);
    const child = createAgent({ provider: childModel, instructions: 'child', description: 'Researches' });
    const lead = createAgent({
      provider: mockModel([{ toolCalls: [{ name: 'task', args: { agent: 'researcher', prompt: 'look', description: 'look' } }] }, 'lead answer']),
      instructions: 'lead',
      tools: [webSearch()],
      subagents: { researcher: child },
    });
    const result = await lead.send('go');
    expect(result.text).toBe('lead answer');
    expect(childModel.calls).toHaveLength(1);
    expect(childModel.calls[0]!.hostedTools).toBeUndefined();
  });

  it('the fingerprint changes with the hosted tools, under their names', async () => {
    const agent = AgentBuilder.create().setName('a').setPrompt('x').build();
    const provider = mockModel([]);
    const none = await fingerprintOf(agent, undefined, provider);
    const withSearch = await fingerprintOf(agent, undefined, provider, [webSearch()]);
    const lowSearch = await fingerprintOf(agent, undefined, provider, [webSearch({ searchContextSize: 'low' })]);
    expect(Object.keys(withSearch.tools)).toEqual(['web_search']);
    expect(withSearch.hash).not.toBe(none.hash);
    expect(lowSearch.tools.web_search).not.toBe(withSearch.tools.web_search);
    expect((await fingerprintOf(agent, undefined, provider, [])).hash).toBe(none.hash);
  });
});

describe('wrappers, cassettes and the UI stream', () => {
  const bare = { name: 'bare', generate: vi.fn(), stream: vi.fn(), supportsTools: () => true, supportsStreaming: () => true, getModels: async () => [] };

  it('withRetry() and withFallback() ask the (first) wrapped provider', () => {
    expect(withRetry(mockModel([])).supportsHostedTool?.('web_search')).toBe(true);
    expect(withRetry(bare).supportsHostedTool?.('web_search')).toBe(false);
    expect(withFallback([mockModel([]), bare]).supportsHostedTool?.('web_search')).toBe(true);
    expect(withFallback([bare, mockModel([])]).supportsHostedTool?.('web_search')).toBe(false);
  });

  it('a cassette records and replays hosted calls (generate and stream)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-cassette-'));
    const cassette = path.join(dir, 'hosted.json');
    try {
      const turn = { text: 'answer', hostedToolCalls: [search] };
      const recorder = recordReplay(mockModel([turn, turn]), { cassette, mode: 'record' });
      expect(recorder.supportsHostedTool?.('web_search')).toBe(true);
      await recorder.generate({ messages: [{ role: 'user', content: 'a' }] });
      const recordedStream = await recorder.stream({ messages: [{ role: 'user', content: 'b' }] });
      for await (const chunk of recordedStream.fullStream) void chunk;
      await recorder.save();

      const player = recordReplay(undefined, { cassette, mode: 'replay' });
      expect(player.supportsHostedTool?.('web_search')).toBe(true);
      expect((await player.generate({ messages: [{ role: 'user', content: 'a' }] })).hostedToolCalls).toEqual([search]);
      const replayed = await player.stream({ messages: [{ role: 'user', content: 'b' }] });
      const chunks: StreamChunk[] = [];
      for await (const chunk of replayed.fullStream) chunks.push(chunk);
      expect(chunks.filter((chunk) => chunk.type === 'hosted-tool-result').map((chunk) => chunk.hostedToolCall)).toEqual([search]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the AI SDK UI stream marks a provider-run call providerExecuted', async () => {
    const model = mockModel([{ text: 'answer', hostedToolCalls: [search] }]);
    const run = createAgent({ provider: model, instructions: 'x', tools: [webSearch()] }).stream('go');
    const reader = toUIMessageStream(run).getReader();
    const chunks: Array<{ type: string; providerExecuted?: boolean }> = [];
    for (let next = await reader.read(); !next.done; next = await reader.read()) chunks.push(next.value as { type: string; providerExecuted?: boolean });
    const tool = chunks.filter((chunk) => chunk.type.startsWith('tool-'));
    expect(tool.map((chunk) => [chunk.type, chunk.providerExecuted])).toEqual([
      ['tool-input-start', true],
      ['tool-input-available', true],
      ['tool-output-available', true],
    ]);
  });
});

describe('approvals', () => {
  it('a run resumed after an approval keeps sending the hosted tools', async () => {
    const send = defineTool({ name: 'send', description: 'Send', input: z.object({}), needsApproval: true, execute: async () => 'sent' });
    const model = mockModel([{ hostedToolCalls: [search], toolCalls: [{ name: 'send', id: 'call_s' }] }, 'Sent.']);
    const agent = createAgent({ provider: model, instructions: 'x', tools: [webSearch(), send] });
    const paused = await agent.send('go');
    expect(paused.finishReason).toBe('awaiting-approval');
    const done = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
    expect(done.text).toBe('Sent.');
    expect(model.calls.map((call) => call.hostedTools?.map((tool) => tool.name))).toEqual([['web_search'], ['web_search']]);
  });
});

describe('hosted tools under permission modes (N1a x N4)', () => {
  const allHosted = () => [webSearch(), fileSearch({ vectorStoreIds: ['vs_1'] }), codeInterpreter(), hostedTool('image_generation', { type: 'provider' })];
  const sentNames = (model: ReturnType<typeof mockModel>) => model.calls.map((call) => call.hostedTools?.map((tool) => tool.name));

  it('hostedToolsInMode(): plan keeps only web and file search; other modes keep every tool', () => {
    const tools = allHosted();
    expect(hostedToolsInMode(tools, 'plan')?.map((tool) => tool.name)).toEqual(['web_search', 'file_search']);
    for (const mode of ['default', 'acceptEdits', 'dontAsk'] as const) expect(hostedToolsInMode(tools, mode)).toBe(tools);
    expect(hostedToolsInMode(undefined, 'plan')).toBeUndefined();
  });

  it('plan mode sends only the read-only hosted tools to the provider', async () => {
    const model = mockModel(['Planned.']);
    await createAgent({ provider: model, instructions: 'x', tools: allHosted(), permissionMode: 'plan' }).send('go');
    expect(sentNames(model)).toEqual([['web_search', 'file_search']]);
  });

  it('plan mode with only a code interpreter sends no hosted tools at all', async () => {
    const model = mockModel(['Planned.']);
    await createAgent({ provider: model, instructions: 'x', tools: [codeInterpreter()], permissionMode: 'plan' }).send('go');
    expect(model.lastCall?.hostedTools).toBeUndefined();
  });

  it.each(['default', 'acceptEdits', 'dontAsk'] as const)('%s mode sends every hosted tool', async (permissionMode) => {
    const model = mockModel(['Done.']);
    await createAgent({ provider: model, instructions: 'x', tools: allHosted(), permissionMode }).send('go');
    expect(sentNames(model)).toEqual([['web_search', 'file_search', 'code_interpreter', 'image_generation']]);
  });

  it('a session switched to plan mode drops the code interpreter from the next call, and gets it back after', async () => {
    const model = mockModel(['One.', 'Two.', 'Three.']);
    const session = createAgent({ provider: model, instructions: 'x', tools: [webSearch(), codeInterpreter()] }).session();
    await session.send('one');
    session.setPermissionMode('plan');
    await session.send('two');
    session.setPermissionMode('default');
    await session.send('three');
    expect(sentNames(model)).toEqual([['web_search', 'code_interpreter'], ['web_search'], ['web_search', 'code_interpreter']]);
  });

  it('a function mode is read at every model call of a run', async () => {
    let mode: 'default' | 'plan' = 'default';
    const lookup = defineTool({ name: 'lookup', description: 'Look up', input: z.object({}), execute: async () => ((mode = 'plan'), 'ok'), annotations: { readOnlyHint: true } });
    const model = mockModel([{ toolCalls: [{ name: 'lookup', id: 'c1' }] }, 'Done.']);
    await createAgent({ provider: model, instructions: 'x', tools: [codeInterpreter(), lookup], permissionMode: () => mode }).send('go');
    expect(sentNames(model)).toEqual([['code_interpreter'], undefined]);
  });
});
