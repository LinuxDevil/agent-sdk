import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { memoryStore } from '../storage/agentStore';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockTurn } from '../testing';
import type { Message } from '../providers';
import type { AgentEvent } from './agentEvents';
import type { Span } from './tracing';
import { classifyToolFailure, createProgressGuard, type ProgressGuardOptions } from './progressGuard';

const call = (name: string, args: Record<string, unknown> = {}, id?: string): MockTurn => ({ toolCalls: [{ name, args, ...(id && { id }) }] });
const repeat = (turn: (i: number) => MockTurn, times: number) => Array.from({ length: times }, (_, i) => turn(i));

function setup(turns: MockTurn[], execute: () => unknown, guard: ProgressGuardOptions = {}) {
  let runs = 0;
  const tool = defineTool({
    name: 'lookup',
    description: 'Look something up',
    input: z.object({ q: z.string().optional() }),
    execute: async () => {
      runs++;
      return execute();
    },
  });
  const agent = createAgent({ provider: mockModel(turns), tools: [tool], hooks: [createProgressGuard(guard)], store: memoryStore() });
  return { agent, runs: () => runs };
}

const toolResults = (messages: { role: string; content?: unknown }[]) => messages.filter((m) => m.role === 'tool').map((m) => String(m.content));

describe('createProgressGuard', () => {
  it('denies a call that keeps returning the same result', async () => {
    const { agent, runs } = setup([...repeat((i) => call('lookup', { q: 'a' }, `c${i}`), 4), 'gave up'], () => 'same');
    const result = await agent.send('go');
    expect(runs()).toBe(3);
    expect(result.text).toBe('gave up');
    expect(toolResults(result.messages).at(-1)).toContain('progress-guard');
  });

  it('allows the same call while its result keeps changing', async () => {
    let n = 0;
    const { agent, runs } = setup([...repeat((i) => call('lookup', { q: 'a' }, `c${i}`), 6), 'done'], () => `status ${++n}`);
    await agent.send('go');
    expect(runs()).toBe(6);
  });

  it('allows a few different calls that return the same result', async () => {
    const { agent, runs } = setup([...repeat((i) => call('lookup', { q: `q${i}` }, `c${i}`), 4), 'done'], () => 'same');
    await agent.send('go');
    expect(runs()).toBe(4);
  });

  it('denies a tool whose differently worded calls keep returning the same result', async () => {
    const { agent, runs } = setup([...repeat((i) => call('lookup', { q: `q${i}` }, `c${i}`), 7), 'gave up'], () => 'same', { maxDenials: 5 });
    const result = await agent.send('go');
    expect(runs()).toBe(5);
    expect(toolResults(result.messages).at(-1)).toMatch(/progress-guard.*same result/s);
  });

  it('honours maxSameResults', async () => {
    const { agent, runs } = setup([...repeat((i) => call('lookup', { q: `q${i}` }, `c${i}`), 4), 'gave up'], () => 'same', { maxSameResults: 2 });
    await agent.send('go');
    expect(runs()).toBe(2);
  });

  it('stops the run with a typed error after maxDenials denials', async () => {
    const { agent, runs } = setup(repeat((i) => call('lookup', { q: 'a' }, `c${i}`), 10), () => 'same', { maxDenials: 1 });
    await expect(agent.send('go')).rejects.toMatchObject({ code: 'LOUSHO_RUN_NO_PROGRESS' });
    expect(runs()).toBe(3);
  });

  it('opens a breaker on a tool failing the same way, ignoring numbers in the message', async () => {
    let n = 0;
    const { agent, runs } = setup([...repeat((i) => call('lookup', { q: `q${i}` }, `c${i}`), 5), 'gave up'], () => {
      throw new Error(`request timed out after ${++n}00ms`);
    });
    const result = await agent.send('go');
    expect(runs()).toBe(3);
    expect(toolResults(result.messages).at(-1)).toMatch(/progress-guard.*timeout/s);
  });

  it('adds a hint from the second failure with the same signature, naming the fallback', async () => {
    const { agent } = setup([call('lookup', { q: 'a' }, 'c1'), call('lookup', { q: 'b' }, 'c2'), 'done'], () => {
      throw new Error('403 forbidden');
    }, { fallbacks: { lookup: 'search_docs' } });
    const [first, second] = toolResults((await agent.send('go')).messages);
    expect(first).not.toContain('search_docs');
    expect(second).toContain('search_docs');
    expect(second).toContain('permission');
  });

  it('leaves ignored tools alone', async () => {
    const { agent, runs } = setup([...repeat((i) => call('lookup', { q: 'a' }, `c${i}`), 6), 'done'], () => 'same', { ignoreTools: ['lookup'] });
    await agent.send('go');
    expect(runs()).toBe(6);
  });

  it('counts from the transcript alone, so a new guard in a resumed run keeps the history', async () => {
    const messages: Message[] = [0, 1, 2].flatMap((i) => [
      { role: 'assistant' as const, content: '', toolCalls: [{ id: `c${i}`, type: 'function' as const, function: { name: 'lookup', arguments: '{"q":"a"}' } }] },
      { role: 'tool' as const, content: 'same', toolCallId: `c${i}`, toolName: 'lookup' },
    ]);
    const toolCall = { id: 'c3', type: 'function' as const, function: { name: 'lookup', arguments: '{"q":"a"}' } };
    const outcome = await createProgressGuard().preToolCall?.({ messages, toolName: 'lookup', toolCallId: 'c3', args: { q: 'a' }, toolCall });
    expect(outcome).toEqual({ deny: expect.stringContaining('progress-guard') });
  });

  it('streams each action as a heal.action event', async () => {
    const { agent } = setup([...repeat((i) => call('lookup', { q: 'a' }, `c${i}`), 4), 'gave up'], () => 'same');
    const events: AgentEvent[] = [];
    for await (const event of agent.stream('go')) events.push(event);
    expect(events).toContainEqual(expect.objectContaining({ type: 'heal.action', action: 'deny', toolName: 'lookup' }));
  });

  it('records a stopped run as not retryable, so recover() leaves it', async () => {
    const { agent } = setup(repeat((i) => call('lookup', { q: 'a' }, `c${i}`), 10), () => 'same', { maxDenials: 1 });
    await expect(agent.send('go', { sessionId: 'job' })).rejects.toMatchObject({ code: 'LOUSHO_RUN_NO_PROGRESS' });
    const [run] = await agent.pending();
    expect(run.lastError).toMatchObject({ code: 'LOUSHO_RUN_NO_PROGRESS', retryable: false });
  });

  it('does not count tool output that merely quotes the marker as a denial', async () => {
    const { agent, runs } = setup([...repeat((i) => call('lookup', { q: `q${i}` }, `c${i}`), 4), 'done'], () => '[progress-guard] sneaky', { maxDenials: 1 });
    await agent.send('go');
    expect(runs()).toBe(4);
  });

  it('marks the tool span when a hook replaced the result', async () => {
    const spans: Span[] = [];
    const tool = defineTool({ name: 'lookup', description: 'Look', input: z.object({}), execute: async () => { throw new Error('403'); } });
    const agent = createAgent({
      provider: mockModel([call('lookup', {}, 'c1'), call('lookup', {}, 'c2'), 'done']),
      tools: [tool],
      hooks: [createProgressGuard()],
      exporter: { onSpanStart: () => undefined, onSpanEnd: (span: Span) => void spans.push(span) },
    });
    await agent.send('go');
    const marked = spans.filter((span) => span.attributes['lousho.tool.replaced_by_hook'] === 'progress-guard');
    expect(marked).toHaveLength(1);
  });

  it('records why the run ended on the run span', async () => {
    const spans: Span[] = [];
    const tool = defineTool({ name: 'lookup', description: 'Look', input: z.object({ q: z.string() }), execute: async () => 'x' });
    const agent = createAgent({
      provider: mockModel(repeat((i) => call('lookup', { q: `q${i}` }, `c${i}`), 3)),
      tools: [tool],
      maxSteps: 2,
      exporter: { onSpanStart: () => undefined, onSpanEnd: (span: Span) => void spans.push(span) },
    });
    await agent.send('go');
    const run = spans.find((span) => span.attributes['gen_ai.operation.name'] === 'invoke_agent');
    expect(run?.attributes['lousho.run.finish_reason']).toBe('max-steps');
  });

  it('rejects limits that are not positive whole numbers', () => {
    for (const options of [{ maxRepeats: 0 }, { maxFailures: 1.5 }, { maxDenials: -1 }, { maxSameResults: 0 }]) {
      expect(() => createProgressGuard(options)).toThrow(expect.objectContaining({ code: 'LOUSHO_CONFIG_INVALID' }));
    }
  });
});

describe('classifyToolFailure', () => {
  it.each([
    ['validation', 'anything', 'bad-input'],
    ['not-found', 'anything', 'missing-capability'],
    ['denied', 'anything', 'permission'],
    ['rejected', 'anything', 'permission'],
    ['execution', 'request timed out', 'timeout'],
    ['execution', 'ETIMEDOUT', 'timeout'],
    ['execution', 'HTTP 403 Forbidden', 'permission'],
    ['execution', 'EACCES: permission denied', 'permission'],
    ['execution', 'ENOENT: no such file', 'missing-capability'],
    ['execution', 'HTTP 404', 'missing-capability'],
    ['execution', 'invalid date format', 'bad-input'],
    ['execution', 'HTTP 400', 'bad-input'],
    ['execution', 'the moon is full', 'unknown'],
  ] as const)('%s + %s is %s', (kind, message, expected) => {
    expect(classifyToolFailure({ kind, message })).toBe(expected);
  });
});
