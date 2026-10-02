/**
 * LOU-V15: createAgent()'s `model`, `instructions` and `tools` as functions
 * of the run, resolved once when each run (or session turn) starts.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createAgent, type RunConfigContext } from './createAgent';
import { defineTool, type DefinedTool } from './tools/defineTool';
import { memoryStore } from './storage/agentStore';
import { mockModel, type MockModel } from './testing';
import { textOf } from './providers/content';

function namedTool(name: string, options: { needsApproval?: boolean } = {}): DefinedTool {
  return defineTool({ name, description: name, input: z.object({}), needsApproval: options.needsApproval, execute: async () => `${name} done` });
}

const systemPrompt = (model: MockModel, call: number) => textOf(model.calls[call].messages[0].content);
const toolNames = (model: MockModel, call: number) => (model.calls[call].tools ?? []).map((t) => t.function.name);

describe('createAgent dynamic config (LOU-V15)', () => {
  it('picks the model from the call metadata', async () => {
    const model = mockModel(['cheap', 'pro']);
    const agent = createAgent({ provider: model, model: ({ metadata }) => (metadata?.plan === 'pro' ? 'big-model' : 'small-model') });

    await agent.send('hi', { metadata: { plan: 'free' } });
    await agent.send('hi', { metadata: { plan: 'pro' } });

    expect(model.calls.map((c) => c.model)).toEqual(['small-model', 'big-model']);
  });

  it('builds the instructions from the session id (async)', async () => {
    const model = mockModel(['ok']);
    const agent = createAgent({ provider: model, instructions: async ({ sessionId }) => `You serve tenant ${sessionId}.` });

    await agent.session({ id: 'acme' }).send('hi');

    expect(systemPrompt(model, 0)).toContain('You serve tenant acme.');
  });

  it('chooses the tools from the input, for the model and for execution', async () => {
    const model = mockModel([{ toolCalls: [{ name: 'weather' }] }, 'Sunny.', 'Hello.']);
    const tools = ({ input }: RunConfigContext) => (textOf(input as string).includes('weather') ? [namedTool('weather')] : [namedTool('chat')]);
    const agent = createAgent({ provider: model, tools });

    const result = await agent.send('What is the weather?');
    await agent.send('Say hello');

    expect(result.text).toBe('Sunny.');
    expect(result.messages.find((m) => m.role === 'tool')?.content).toBe(JSON.stringify('weather done'));
    expect(toolNames(model, 0)).toEqual(['weather']);
    expect(toolNames(model, 2)).toEqual(['chat']);
  });

  it('a resolver that throws fails the run with LOUSHO_CONFIG_RESOLVER_FAILED naming the option', async () => {
    const model = mockModel([]);
    const boom = new Error('no such tenant');
    const agent = createAgent({ provider: model, tools: () => { throw boom; } });

    await expect(agent.send('hi')).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_RESOLVER_FAILED', field: 'tools', cause: boom });
    await expect(agent.stream('hi').result).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_RESOLVER_FAILED' });
    const session = agent.session();
    await expect(session.send('hi')).rejects.toThrow(/'tools' function threw/);
    expect(session.messages).toEqual([]);
    expect(model.calls).toHaveLength(0);
  });

  it('resolves again on every session turn, with that turn\'s input and metadata', async () => {
    const model = mockModel(['one', 'two']);
    const resolveModel = vi.fn(({ metadata }: RunConfigContext) => String(metadata?.model));
    const agent = createAgent({ provider: model, model: resolveModel, instructions: ({ input }) => `Turn about: ${textOf(input as string)}` });
    const session = agent.session({ id: 's1' });

    await session.send('first', { metadata: { model: 'model-1' } });
    const run = session.stream('second', { metadata: { model: 'model-2' } });
    for await (const event of run) void event;

    expect(model.calls.map((c) => c.model)).toEqual(['model-1', 'model-2']);
    expect(systemPrompt(model, 1)).toContain('Turn about: second');
    expect(resolveModel).toHaveBeenCalledTimes(2);
    expect(resolveModel.mock.calls[1][0]).toMatchObject({ sessionId: 's1', input: 'second' });
  });

  it('a run resumed after approval keeps its model and re-resolves its tools with the same ctx', async () => {
    const store = memoryStore();
    const send = namedTool('send_email', { needsApproval: true });
    const options = (provider: MockModel, picked: string[]) => ({
      provider,
      store,
      // Not deterministic on purpose: a resumed run must not switch model.
      model: () => `model-${picked.push('x')}`,
      tools: ({ metadata }: RunConfigContext) => (metadata?.role === 'admin' ? [send] : []),
    });
    const first = mockModel([{ toolCalls: [{ name: 'send_email' }] }]);
    const paused = await createAgent(options(first, [])).send('Email Sam', { sessionId: 'job', metadata: { role: 'admin' } });
    expect(paused.finishReason).toBe('awaiting-approval');

    // A fresh agent (e.g. after a restart) resumes from the stored approval.
    const second = mockModel(['Sent.']);
    const result = await createAgent(options(second, ['already', 'moved'])).approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(result.text).toBe('Sent.');
    expect(result.messages.find((m) => m.role === 'tool')?.content).toBe(JSON.stringify('send_email done'));
    expect(first.calls[0].model).toBe('model-1');
    expect(second.calls[0].model).toBe('model-1');
  });

  it('a dynamic agent used as a sub-agent resolves its config from the task prompt', async () => {
    const childModel = mockModel(['child answer']);
    const child = createAgent({ provider: childModel, description: 'Helps', instructions: ({ input }) => `Child for: ${String(input)}` });
    const lead = createAgent({
      provider: mockModel([{ toolCalls: [{ name: 'task', args: { agent: 'child', prompt: 'find X', description: 'find' } }] }, 'done']),
      subagents: { child },
    });

    expect((await lead.send('go')).text).toBe('done');
    expect(systemPrompt(childModel, 0)).toContain('Child for: find X');
  });
});
