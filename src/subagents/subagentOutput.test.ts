import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { z as z4 } from 'zod/v4';
import { createAgent } from '../createAgent';
import { mockModel } from '../testing';
import type { Message } from '../providers';

const weather = z.object({ city: z.string(), tempC: z.number() });
const callTask = (prompt: string) => ({ name: 'task', args: { agent: 'reporter', prompt, description: 'weather' } });
const toolContent = (messages: readonly Message[]): unknown => JSON.parse(messages.find((m) => m.role === 'tool')?.content as string);

describe('structured output of sessions and sub-agents (LOU-V4.2)', () => {
  it('session.send() returns the validated object', async () => {
    const agent = createAgent({ provider: mockModel(['{"city":"Oslo","tempC":-3}']), output: weather });
    const result = await agent.session().send('Weather in Oslo?');
    expect(result.object).toEqual({ city: 'Oslo', tempC: -3 });
    expect(result.finishReason).toBe('stop');
  });

  it('accepts a zod 4 output schema', async () => {
    const agent = createAgent({ provider: mockModel(['{"city":"Oslo","tempC":-3}']), output: z4.object({ city: z4.string(), tempC: z4.number() }) });
    expect((await agent.send('Weather?')).object).toEqual({ city: 'Oslo', tempC: -3 });
  });

  it('returns the sub-agent object as JSON to the lead, with the taskId footer', async () => {
    const reporter = createAgent({ provider: mockModel(['{"city":"Oslo","tempC":-3}']), description: 'Reports weather', output: weather });
    const leadModel = mockModel([{ toolCalls: [callTask('Oslo')] }, 'done']);
    const lead = createAgent({ provider: leadModel, subagents: { reporter } });
    const result = await lead.send('Weather?');
    expect(toolContent(result.messages)).toBe(
      `{"city":"Oslo","tempC":-3}\n\n[sub-agent 'reporter': 1 step(s), finish reason 'stop', taskId 'task_1']`
    );
    expect(result.object).toBeUndefined();
  });

  it('does not inherit the lead output schema', async () => {
    const reporterModel = mockModel(['plain text']);
    const reporter = createAgent({ provider: reporterModel, description: 'Reports weather' });
    const lead = createAgent({ provider: mockModel([{ toolCalls: [callTask('Oslo')] }, '{"city":"Oslo","tempC":1}']), subagents: { reporter }, output: weather });
    const result = await lead.send('Weather?');
    expect(JSON.stringify(reporterModel.calls[0].messages)).not.toContain('Output format');
    expect(result.object).toEqual({ city: 'Oslo', tempC: 1 });
  });

  it('turns an invalid child object into a structured tool error', async () => {
    const reporter = createAgent({ provider: mockModel(['nope', 'still nope']), description: 'Reports weather', output: weather });
    const lead = createAgent({ provider: mockModel([{ toolCalls: [callTask('Oslo')] }, 'sorry']), subagents: { reporter } });
    const result = await lead.send('Weather?');
    expect(toolContent(result.messages)).toMatchObject({ toolName: 'task', kind: 'execution' });
    expect(JSON.stringify(toolContent(result.messages))).toContain('did not return a valid object');
  });
});
