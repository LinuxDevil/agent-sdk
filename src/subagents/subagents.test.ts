import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import type { Message } from '../providers';
import type { SubagentCatalog } from './types';

const task = (agent: string, prompt: string, id?: string) => ({
  name: 'task',
  args: { agent, prompt, description: `${agent} task` },
  ...(id ? { id } : {}),
});

function toolMessages(messages: readonly Message[]): Message[] {
  return messages.filter((m) => m.role === 'tool');
}

describe('subagents option and the task tool (LOU-Y3)', () => {
  it('runs a sub-agent on only the task prompt and returns its answer with a metadata footer', async () => {
    const researcherModel = mockModel(['Paris is the capital of France.']);
    const researcher = createAgent({
      provider: researcherModel,
      instructions: 'You research.',
      description: 'Finds and summarizes sources',
    });
    const leadModel = mockModel([{ text: 'Let me ask.', toolCalls: [task('researcher', 'What is the capital of France?')] }, 'Paris.']);
    const lead = createAgent({ provider: leadModel, instructions: 'You coordinate.', subagents: { researcher } });

    const result = await lead.send('Tell me about France, my secret is 42');

    // Isolated context: the child sees its own system prompt and the task prompt only.
    expect(researcherModel.calls[0].messages).toEqual([
      { role: 'system', content: 'You research.' },
      { role: 'user', content: 'What is the capital of France?' },
    ]);
    expect(JSON.stringify(researcherModel.calls[0].messages)).not.toContain('secret');

    // The lead sees the sub-agent list and the single `task` tool.
    const leadRequest = leadModel.calls[0];
    expect(leadRequest.messages[0].content).toContain('## Available sub-agents');
    expect(leadRequest.messages[0].content).toContain('- researcher: Finds and summarizes sources');
    expect(leadRequest.tools?.map((t) => t.function.name)).toEqual(['task']);

    const [toolResult] = toolMessages(result.messages);
    const text = JSON.parse(toolResult.content as string) as string;
    expect(text).toBe("Paris is the capital of France.\n\n[sub-agent 'researcher': 1 step(s), finish reason 'stop']");
    expect(result.text).toBe('Paris.');
  });

  it('runs several task calls of one turn in parallel', async () => {
    let started = 0;
    let releaseAll!: () => void;
    const bothStarted = new Promise<void>((resolve) => (releaseAll = resolve));
    const rendezvous = defineTool({
      name: 'rendezvous',
      description: 'Waits until both sub-agents are running',
      input: z.object({}),
      execute: async () => {
        started++;
        if (started === 2) releaseAll();
        await Promise.race([
          bothStarted,
          new Promise((_, reject) => setTimeout(() => reject(new Error('sub-agents did not run in parallel')), 2000)),
        ]);
        return 'met';
      },
    });
    const child = (name: string) =>
      createAgent({
        name,
        provider: mockModel([{ toolCalls: [{ name: 'rendezvous' }] }, `${name} done`]),
        tools: [rendezvous],
        description: `The ${name}`,
      });
    const leadModel = mockModel([{ toolCalls: [task('researcher', 'a', 't1'), task('writer', 'b', 't2')] }, 'all done']);
    const lead = createAgent({ provider: leadModel, subagents: { researcher: child('researcher'), writer: child('writer') } });

    const result = await lead.send('go');

    expect(result.text).toBe('all done');
    const results = toolMessages(result.messages);
    expect(results.map((m) => m.toolCallId)).toEqual(['t1', 't2']);
    expect(results[0].content).toContain('researcher done');
    expect(results[1].content).toContain('writer done');
    expect(results.some((m) => m.isError)).toBe(false);
  });

  it("streams the sub-agent's events inside the lead's agent.stream(), tagged with subagent", async () => {
    const researcher = createAgent({
      name: 'researcher',
      provider: mockModel([{ toolCalls: [{ name: 'lookup' }] }, 'found it']),
      tools: [defineTool({ name: 'lookup', description: 'Looks up', input: z.object({}), execute: () => 'data' })],
      description: 'Researches',
    });
    const lead = createAgent({
      name: 'lead',
      provider: mockModel([{ toolCalls: [task('researcher', 'look', 'lead-1')] }, 'done']),
      subagents: { researcher },
    });

    const events = [];
    for await (const event of lead.stream('go')) events.push(event);

    const tag = { name: 'researcher', depth: 1, toolCallId: 'lead-1', description: 'researcher task' };
    const child = events.filter((e) => e.subagent).map((e) => [e.type, e.subagent]);
    // (The child's text is streamed: one or more text.delta, collapsed here.)
    const types = child.map(([type]) => type).filter((type, i, all) => type !== 'text.delta' || all[i - 1] !== type);
    expect(types).toEqual([
      'run.start',
      'step.start',
      'tool.start',
      'tool.done',
      'step.done',
      'step.start',
      'text.delta',
      'text.done',
      'step.done',
      'run.done',
    ]);
    expect(child.every(([, subagent]) => JSON.stringify(subagent) === JSON.stringify(tag))).toBe(true);
    const childDone = events.find((e) => e.type === 'run.done' && e.subagent);
    expect(childDone).toMatchObject({ finishReason: 'stop', text: 'found it' });

    const top = events.filter((e) => !e.subagent);
    expect(top[0].type).toBe('run.start');
    expect(top.at(-1)).toMatchObject({ type: 'run.done', text: 'done' });
    expect(events.at(-1)).toBe(top.at(-1));
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    // The child runs inside the lead's task call.
    const taskStart = events.findIndex((e) => e.type === 'tool.start' && !e.subagent);
    const taskDone = events.findIndex((e) => e.type === 'tool.done' && !e.subagent);
    expect(events.findIndex((e) => e.subagent)).toBeGreaterThan(taskStart);
    expect(events.findLastIndex((e) => e.subagent)).toBeLessThan(taskDone);
  });

  describe('maxSubagentDepth', () => {
    function nestedTree(maxSubagentDepth?: number) {
      const helperModel = mockModel(['helped']);
      const helper = createAgent({
        provider: helperModel,
        description: 'Helps',
        subagents: { deeper: createAgent({ provider: mockModel(['x']), description: 'Deeper' }) },
      });
      const researcherModel = mockModel([{ toolCalls: [task('helper', 'help me')] }, 'researched']);
      const researcher = createAgent({ provider: researcherModel, description: 'Researches', subagents: { helper } });
      const leadModel = mockModel([{ toolCalls: [task('researcher', 'research')] }, 'done']);
      const lead = createAgent({ provider: leadModel, subagents: { researcher }, maxSubagentDepth });
      return { lead, leadModel, researcherModel, helperModel };
    }

    it('defaults to 1: sub-agents are not offered the task tool', async () => {
      const { lead, researcherModel } = nestedTree();
      await lead.send('go');
      expect(researcherModel.calls[0].tools).toBeUndefined();
      expect(researcherModel.calls[0].messages[0].content ?? '').not.toContain('Available sub-agents');
    });

    it('with 2, sub-agents can delegate once more, and the limit holds deeper down', async () => {
      const { lead, researcherModel, helperModel } = nestedTree(2);
      const result = await lead.send('go');
      expect(researcherModel.calls[0].tools?.map((t) => t.function.name)).toEqual(['task']);
      // The helper sits at depth 2 = the root's limit: it has sub-agents but no task tool.
      expect(helperModel.calls[0].tools).toBeUndefined();
      expect(toolMessages(researcherModel.calls[1].messages as Message[])[0].content).toContain('helped');
      expect(result.text).toBe('done');
    });

    it('with 0, not even the lead gets the task tool', async () => {
      const { lead, leadModel } = nestedTree(0);
      await lead.send('go').catch(() => undefined);
      expect(leadModel.calls[0].tools).toBeUndefined();
    });

    it('rejects an invalid value', () => {
      expect(() => createAgent({ provider: mockModel([]), maxSubagentDepth: -1 })).toThrow(/maxSubagentDepth/);
    });
  });

  it('lists a dynamic catalog at the start of every run and resolves names on demand', async () => {
    const researcher = createAgent({ provider: mockModel(['found it'], { onExhausted: 'repeat-last' }) });
    const catalog: SubagentCatalog = {
      list: vi.fn(async () => [{ name: 'researcher', description: 'Looks things up' }]),
      resolve: vi.fn(async (name: string) => (name === 'researcher' ? researcher : undefined)),
    };
    const leadModel = mockModel([{ toolCalls: [task('researcher', 'look')] }, 'done', 'hi again']);
    const lead = createAgent({ provider: leadModel, subagents: catalog });

    const result = await lead.send('go');
    await lead.send('again');

    expect(catalog.list).toHaveBeenCalledTimes(2);
    expect(catalog.resolve).toHaveBeenCalledWith('researcher');
    expect(leadModel.calls[0].messages[0].content).toContain('- researcher: Looks things up');
    expect(toolMessages(result.messages)[0].content).toContain('found it');
  });

  it('gives the lead a structured error listing the valid names for an unknown sub-agent', async () => {
    const researcher = createAgent({ provider: mockModel(['x']), description: 'Researches' });
    const leadModel = mockModel([{ toolCalls: [task('nope', 'do it')] }, 'ok']);
    const lead = createAgent({ provider: leadModel, subagents: { researcher } });

    const result = await lead.send('go');

    const [toolResult] = toolMessages(result.messages);
    expect(toolResult.isError).toBe(true);
    expect(toolResult.content).toContain('researcher');
    expect(toolResult.content).toContain('nope');
  });

  it('gives the lead an error result saying why when a sub-agent runs out of steps', async () => {
    const looping = defineTool({ name: 'again', description: 'loops', input: z.object({}), execute: () => 'more' });
    const researcher = createAgent({
      provider: mockModel([{ text: 'still working', toolCalls: [{ name: 'again' }] }], { onExhausted: 'repeat-last' }),
      tools: [looping],
      maxSteps: 2,
      description: 'Researches',
    });
    const lead = createAgent({ provider: mockModel([{ toolCalls: [task('researcher', 'go')] }, 'ok']), subagents: { researcher } });

    const [toolResult] = toolMessages((await lead.send('go')).messages);

    expect(toolResult.isError).toBe(true);
    expect(toolResult.content).toContain("Sub-agent 'researcher' used all 2 of its steps");
    expect(toolResult.content).toContain('still working');
  });

  it('gives the lead an error result when a sub-agent fails', async () => {
    const researcher = createAgent({ provider: mockModel([{ error: new Error('model is down') }]), description: 'Researches' });
    const lead = createAgent({ provider: mockModel([{ toolCalls: [task('researcher', 'go')] }, 'ok']), subagents: { researcher } });

    const [toolResult] = toolMessages((await lead.send('go')).messages);

    expect(toolResult.isError).toBe(true);
    expect(toolResult.content).toContain("Sub-agent 'researcher' failed:");
  });

  it("adds sub-agents' token usage to the lead's", async () => {
    const researcher = createAgent({
      provider: mockModel([{ text: 'r', usage: { inputTokens: 100, outputTokens: 10 } }]),
      description: 'Researches',
    });
    const lead = createAgent({
      provider: mockModel([
        { toolCalls: [task('researcher', 'go')], usage: { inputTokens: 1, outputTokens: 1 } },
        { text: 'done', usage: { inputTokens: 2, outputTokens: 2 } },
      ]),
      subagents: { researcher },
    });

    const { usage } = await lead.send('go');

    expect(usage).toEqual({ promptTokens: 103, completionTokens: 13, totalTokens: 116 });
  });

  describe('configuration errors', () => {
    const researcher = createAgent({ provider: mockModel([]), description: 'Researches' });

    it('requires a description on every sub-agent', () => {
      const undescribed = createAgent({ provider: mockModel([]) });
      expect(() => createAgent({ provider: mockModel([]), subagents: { undescribed } })).toThrow(
        /sub-agent 'undescribed' has no description/
      );
    });

    it('only accepts createAgent() agents', () => {
      const fake = { send: async () => ({}) } as unknown as typeof researcher;
      expect(() => createAgent({ provider: mockModel([]), subagents: { fake } })).toThrow(/not an agent created with createAgent/);
    });

    it('refuses a user tool already named task', () => {
      const own = defineTool({ name: 'task', description: 'mine', input: z.object({}), execute: () => 'x' });
      expect(() => createAgent({ provider: mockModel([]), tools: [own], subagents: { researcher } })).toThrow(
        /a tool named 'task' is already registered/
      );
    });

    it('rejects a catalog that lists a sub-agent without a description', async () => {
      const lead = createAgent({
        provider: mockModel(['x']),
        subagents: { list: () => [{ name: 'a', description: ' ' }], resolve: () => undefined },
      });
      await expect(lead.send('go')).rejects.toThrow(/without a description/);
    });

    it('rejects a catalog that lists a name twice', async () => {
      const lead = createAgent({
        provider: mockModel(['x']),
        subagents: { list: () => [{ name: 'a', description: 'A' }, { name: 'a', description: 'A' }], resolve: () => undefined },
      });
      await expect(lead.send('go')).rejects.toThrow(/the name 'a' twice/);
    });

    it('offers no task tool for an empty catalog', async () => {
      const model = mockModel(['x']);
      await createAgent({ provider: model, subagents: { list: () => [], resolve: () => undefined } }).send('go');
      expect(model.calls[0].tools).toBeUndefined();
    });
  });
});
