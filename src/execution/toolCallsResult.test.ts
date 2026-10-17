import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import { normalizeToolCall, toolCallArgs, toolCallName } from '../providers';
import type { ToolCall } from '../providers';

const echo = defineTool({
  name: 'echo',
  description: 'Echoes its input',
  input: z.object({ t: z.string() }),
  execute: async ({ t }) => `echoed:${t}`,
});

const gated = defineTool({
  name: 'gated',
  description: 'Always asks',
  input: z.object({ t: z.string() }),
  needsApproval: true,
  execute: async ({ t }) => `ran:${t}`,
});

const names = (result: { toolCalls: ToolCall[] }) => result.toolCalls.map((call) => call.function.name);

describe('result.toolCalls completeness', () => {
  it('collects the calls of every turn of the run', async () => {
    const model = mockModel([
      { toolCalls: [{ name: 'echo', args: { t: 'one' }, id: 'c1' }] },
      { toolCalls: [{ name: 'echo', args: { t: 'two' }, id: 'c2' }] },
      'done',
    ]);
    const result = await createAgent({ provider: model, tools: [echo] }).send('go');
    expect(names(result)).toEqual(['echo', 'echo']);
  });

  it('an awaiting-approval result keeps the calls waiting on a decision', async () => {
    const model = mockModel([{ toolCalls: [{ name: 'gated', args: { t: 'x' }, id: 'c1' }] }]);
    const agent = createAgent({ provider: model, tools: [gated] });
    const paused = await agent.send('go');
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(names(paused)).toEqual(['gated']);
  });

  it('a denied approval resolution keeps the run\u2019s earlier calls', async () => {
    const model = mockModel([{ toolCalls: [{ name: 'gated', args: { t: 'x' }, id: 'c1' }] }, 'rejected, understood']);
    const agent = createAgent({ provider: model, tools: [gated] });
    const paused = await agent.send('go');
    const denied = await agent.approvals.resolve({ id: paused.approvalId!, approved: false, note: 'no' });
    expect(denied.finishReason).toBe('stop');
    // Before the fix this came back [] - the continued run seeded no calls.
    expect(names(denied)).toEqual(['gated']);
  });

  it('an approved call resolution keeps earlier calls plus the approved one', async () => {
    const model = mockModel([{ toolCalls: [{ name: 'gated', args: { t: 'x' }, id: 'c1' }] }, { toolCalls: [{ name: 'echo', args: { t: 'y' }, id: 'c2' }] }, 'all done']);
    const agent = createAgent({ provider: model, tools: [gated, echo] });
    const paused = await agent.send('go');
    const resolved = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
    expect(resolved.text).toBe('all done');
    expect(names(resolved)).toEqual(['gated', 'echo']);
  });
});

describe('step-limit surfacing', () => {
  it('a max-steps run that produced no text still says what happened', async () => {
    const model = mockModel([{ toolCalls: [{ name: 'echo', args: { t: 'x' }, id: 'c1' }] }], { onExhausted: 'repeat-last' });
    const result = await createAgent({ provider: model, tools: [echo], maxSteps: 3 }).send('loop');
    expect(result.finishReason).toBe('max-steps');
    expect(result.text).toMatch(/step limit/);
    expect(result.text).toMatch(/tool call/);
  });
});

describe('normalizeToolCall / toolCallName / toolCallArgs', () => {
  const wire: ToolCall = { id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"t":"hi"}' } };

  it('reads the wire shape', () => {
    expect(toolCallName(wire)).toBe('echo');
    expect(toolCallArgs(wire)).toEqual({ t: 'hi' });
    expect(normalizeToolCall(wire)).toEqual({ id: 'c1', name: 'echo', args: { t: 'hi' }, rawArgs: '{"t":"hi"}' });
  });

  it('reads the flat mock-script shape', () => {
    expect(toolCallName({ name: 'echo' })).toBe('echo');
    expect(toolCallArgs({ args: { t: 'hi' } })).toEqual({ t: 'hi' });
  });

  it('invalid JSON arguments come back undefined, never throw', () => {
    expect(toolCallArgs({ function: { arguments: 'not json' } })).toBeUndefined();
    expect(toolCallArgs({ function: { arguments: '[1,2]' } })).toBeUndefined();
    expect(toolCallArgs({})).toBeUndefined();
  });
});
