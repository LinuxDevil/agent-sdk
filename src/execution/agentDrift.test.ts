/**
 * LOU-W9.2: checkpoints and approval snapshots carry an agent fingerprint, and a
 * resume by a changed agent warns, refuses or carries on (`onAgentDrift`).
 * LOU-V15.2: a crash resume of a dynamic agent re-resolves with the run's saved `ctx` and model.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgent, type CreateAgentConfig } from '../createAgent';
import { defineTool, type DefinedTool } from '../tools/defineTool';
import { ToolRegistry } from '../tools';
import { PropagatingToolError } from './AgentExecutor';
import { fingerprintOf } from './agentFingerprint';
import { memoryStore, type AgentStore } from '../storage/agentStore';
import { SqliteStore } from '../storage/sqlite';
import { mockModel, type MockTurn } from '../testing';
import type { AgentEvent } from './agentEvents';
import type { AgentRun } from './agentRun';

const stores: Array<[string, () => AgentStore]> = [
  ['in-memory store', () => memoryStore()],
  ['SQLite store', () => new SqliteStore(':memory:')],
];

interface Tools {
  runs: Record<string, number>;
  list: DefinedTool[];
}

/** Tools named `names`; `crash` dies (PropagatingToolError) on its first run; `approve` needs approval. */
function toolsOf(names: string[], options: { crash?: string; approve?: string; input?: z.ZodRawShape } = {}): Tools {
  const runs: Record<string, number> = {};
  const list = names.map((name) => {
    runs[name] = 0;
    return defineTool({
      name,
      description: name,
      input: z.object(options.input ?? {}),
      needsApproval: options.approve === name,
      execute: async () => {
        runs[name]++;
        if (options.crash === name && runs[name] === 1) throw new PropagatingToolError(`died in ${name}`);
        return `${name} done`;
      },
    });
  });
  return { runs, list };
}

const calling = (name: string): MockTurn => ({ toolCalls: [{ name, id: `call_${name}` }] });

async function collect(run: AgentRun): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

afterEach(() => vi.restoreAllMocks());

describe('agent fingerprint (LOU-W9.2)', () => {
  const registryOf = (tools: DefinedTool[]) => {
    const registry = new ToolRegistry();
    for (const tool of tools) registry.register(tool);
    return registry;
  };
  const agentOf = (tools: DefinedTool[], prompt = 'Be brief.', model?: string) => ({
    name: 'a',
    prompt,
    tools: Object.fromEntries(tools.map((t) => [t.name, { tool: t.name }])),
    ...(model && { settings: { model } }),
  });

  it('is stable: same for any tool order and ignores functions; changes with model, tool schema, tool names and instructions', async () => {
    const provider = mockModel([], { defaultModel: 'm1' });
    const a = toolsOf(['x', 'y']).list;
    const base = await fingerprintOf(agentOf(a), registryOf(a), provider);

    expect(base.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(base).toMatchObject({ model: 'm1', tools: { x: expect.any(String), y: expect.any(String) } });
    expect(await fingerprintOf(agentOf([a[1], a[0]]), registryOf([a[1], a[0]]), provider)).toEqual(base);
    expect(await fingerprintOf(agentOf(toolsOf(['x', 'y']).list), registryOf(toolsOf(['x', 'y']).list), provider)).toEqual(base);

    const withInput = toolsOf(['x', 'y'], { input: { q: z.string() } }).list;
    const variants = [
      await fingerprintOf(agentOf(a, 'Be long.'), registryOf(a), provider),
      await fingerprintOf(agentOf(a, 'Be brief.', 'm2'), registryOf(a), provider),
      await fingerprintOf(agentOf(a), registryOf(a), mockModel([], { defaultModel: 'm3' })),
      await fingerprintOf(agentOf(a.slice(0, 1)), registryOf(a), provider),
      await fingerprintOf(agentOf(withInput), registryOf(withInput), provider),
    ];
    for (const variant of variants) expect(variant.hash).not.toBe(base.hash);
    expect(variants[4].tools.x).not.toBe(base.tools.x);
    expect(variants[4].tools.y).not.toBe(base.tools.y);
  });
});

describe.each(stores)('resuming with a changed agent: %s', (_name, makeStore) => {
  /** Crashes a durable run in tool `b` (its call is checkpointed without a result) and returns the store. */
  async function crashedRun(config: Partial<CreateAgentConfig> = {}, sessionId = 'job-1') {
    const store = makeStore();
    const { list } = toolsOf(['a', 'b'], { crash: 'b' });
    const first = createAgent({ provider: mockModel([calling('a'), calling('b')], { defaultModel: 'gpt-old' }), instructions: 'Be brief.', tools: list, store, ...config });
    await expect(first.send('go', { sessionId })).rejects.toThrow('died in b');
    return { store, sessionId };
  }

  const resumer = (store: AgentStore, config: Partial<CreateAgentConfig> = {}, model = mockModel(['Resumed.'], { defaultModel: 'gpt-new' })) => ({
    model,
    agent: createAgent({ provider: model, instructions: 'Be brief.', tools: toolsOf(['a', 'b']).list, store, ...config }),
  });

  it('writes the fingerprint (model, tool names, instructions hash) into every checkpoint', async () => {
    const { store, sessionId } = await crashedRun();

    const checkpoint = await store.checkpoints!.load(sessionId);

    expect(checkpoint?.agentFingerprint).toMatchObject({ model: 'gpt-old', tools: { a: expect.any(String), b: expect.any(String) }, instructions: expect.any(String) });
  });

  it("'warn' (default) continues, warns naming the model and emits agent.drift", async () => {
    const { store, sessionId } = await crashedRun();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { agent, model } = resumer(store);

    const events = await collect(agent.stream([], { sessionId }));

    expect(events.find((e) => e.type === 'agent.drift')).toMatchObject({ model: { from: 'gpt-old', to: 'gpt-new' }, toolsAdded: [], toolsRemoved: [], instructions: false });
    expect(events.at(-1)).toMatchObject({ type: 'run.done', finishReason: 'stop', text: 'Resumed.' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('model gpt-old -> gpt-new'));
    expect(model.calls).toHaveLength(1);
  });

  it("'error' rejects with LOUSHO_AGENT_DRIFT before any model call or tool, leaving the checkpoint untouched", async () => {
    const { store, sessionId } = await crashedRun();
    const before = structuredClone(await store.checkpoints!.load(sessionId));
    const tools = toolsOf(['a', 'b']);
    const model = mockModel(['Resumed.'], { defaultModel: 'gpt-new' });
    const agent = createAgent({ provider: model, instructions: 'Changed.', tools: tools.list, store, onAgentDrift: 'error' });

    await expect(agent.resume(sessionId)).rejects.toMatchObject({ code: 'LOUSHO_AGENT_DRIFT', detail: expect.stringMatching(/model gpt-old -> gpt-new.*instructions changed/) });

    expect(model.calls).toHaveLength(0);
    expect(tools.runs).toEqual({ a: 0, b: 0 });
    expect(await store.checkpoints!.load(sessionId)).toEqual(before);
  });

  it("'ignore' continues without a warning, and the same agent never warns", async () => {
    const { store, sessionId } = await crashedRun();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const ignored = await resumer(store, { onAgentDrift: 'ignore' }).agent.resume(sessionId);
    expect(ignored?.text).toBe('Resumed.');
    expect(warn).not.toHaveBeenCalled();

    const same = await crashedRun();
    const result = await resumer(same.store, {}, mockModel(['Same.'], { defaultModel: 'gpt-old' })).agent.resume(same.sessionId);
    expect(result?.text).toBe('Same.');
    expect(warn).not.toHaveBeenCalled();
  });

  it('names tools added, removed and changed', async () => {
    const { store, sessionId } = await crashedRun();
    const resuming = createAgent({
      provider: mockModel(['x'], { defaultModel: 'gpt-old' }),
      instructions: 'Be brief.',
      tools: [...toolsOf(['a', 'c']).list.map((t) => (t.name === 'a' ? toolsOf(['a'], { input: { q: z.string() } }).list[0] : t)), ...toolsOf(['b']).list],
      store,
      onAgentDrift: 'error',
    });
    await expect(resuming.resume(sessionId)).rejects.toMatchObject({ detail: expect.stringMatching(/tools added: c.*tools changed \(input schema\): a/) });

    const without = createAgent({ provider: mockModel(['x'], { defaultModel: 'gpt-old' }), instructions: 'Be brief.', tools: toolsOf(['a']).list, store, onAgentDrift: 'error' });
    await expect(without.resume(sessionId)).rejects.toMatchObject({ code: 'LOUSHO_RESUME_TOOL_MISSING' });
  });

  it('a checkpoint saved before the fingerprint existed resumes with no warning or error', async () => {
    const { store, sessionId } = await crashedRun();
    const old = { ...(await store.checkpoints!.load(sessionId))! };
    delete old.agentFingerprint;
    await store.checkpoints!.save(sessionId, old);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await resumer(store, { onAgentDrift: 'error' }).agent.resume(sessionId);

    expect(result?.text).toBe('Resumed.');
    expect(warn).not.toHaveBeenCalled();
  });

  it("a pending tool call whose tool is gone is always an error, whatever onAgentDrift is", async () => {
    for (const onAgentDrift of ['warn', 'error', 'ignore'] as const) {
      const { store, sessionId } = await crashedRun();
      const model = mockModel(['never']);
      const agent = createAgent({ provider: model, instructions: 'Be brief.', tools: toolsOf(['a']).list, store, onAgentDrift });

      await expect(agent.resume(sessionId)).rejects.toMatchObject({ code: 'LOUSHO_RESUME_TOOL_MISSING', detail: expect.stringContaining("'b'") });

      expect(model.calls).toHaveLength(0);
      expect((await store.checkpoints!.load(sessionId))?.status).toBe('in-progress');
    }
  });

  it('works for sessions: session.resume() checks the turn checkpoint', async () => {
    const store = makeStore();
    const first = createAgent({ provider: mockModel([calling('a'), calling('b')], { defaultModel: 'gpt-old' }), tools: toolsOf(['a', 'b'], { crash: 'b' }).list, store });
    await expect(first.session({ id: 'chat' }).send('go')).rejects.toThrow('died in b');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const model = mockModel(['x'], { defaultModel: 'gpt-new' });
    const strict = createAgent({ provider: model, tools: toolsOf(['a', 'b']).list, store, onAgentDrift: 'error' });
    await expect(strict.session({ id: 'chat' }).resume()).rejects.toMatchObject({ code: 'LOUSHO_AGENT_DRIFT' });
    expect(model.calls).toHaveLength(0);

    const lenient = createAgent({ provider: mockModel(['Done.'], { defaultModel: 'gpt-new' }), tools: toolsOf(['a', 'b']).list, store });
    expect((await lenient.session({ id: 'chat' }).resume())?.text).toBe('Done.');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('gpt-old -> gpt-new'));
  });

  describe('approvals', () => {
    async function pausedRun(config: Partial<CreateAgentConfig> = {}) {
      const store = makeStore();
      const tools = toolsOf(['lookup', 'send'], { approve: 'send' });
      const agent = createAgent({ provider: mockModel([calling('send')], { defaultModel: 'gpt-old' }), instructions: 'Be brief.', tools: tools.list, store, ...config });
      const paused = await agent.send('go', { sessionId: 'job-2' });
      expect(paused.finishReason).toBe('awaiting-approval');
      return { store, approvalId: paused.approvalId! };
    }
    const resumedBy = (store: AgentStore, config: Partial<CreateAgentConfig>, tools = toolsOf(['lookup', 'send'], { approve: 'send' })) => ({
      tools,
      model: mockModel(['Sent.'], { defaultModel: 'gpt-new' }),
      make(model = mockModel(['Sent.'], { defaultModel: 'gpt-new' })) {
        return createAgent({ provider: model, instructions: 'Be brief.', tools: tools.list, store, ...config });
      },
    });

    it('the snapshot carries the fingerprint; a changed model warns and continues (also streamed)', async () => {
      const { store, approvalId } = await pausedRun();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const resumer2 = resumedBy(store, {});

      const events = await collect(resumer2.make().approvals.streamResolve({ id: approvalId, approved: true }));

      expect(events.map((e) => e.type).slice(0, 2)).toEqual(['run.start', 'agent.drift']);
      expect(events.find((e) => e.type === 'agent.drift')).toMatchObject({ model: { from: 'gpt-old', to: 'gpt-new' } });
      expect(events.at(-1)).toMatchObject({ type: 'run.done', text: 'Sent.' });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(resumer2.tools.runs.send).toBe(1);
    });

    it("'error' refuses before the tool runs and leaves the approval pending for the right agent", async () => {
      const { store, approvalId } = await pausedRun();
      const wrong = resumedBy(store, { onAgentDrift: 'error' });

      await expect(wrong.make().approvals.resolve({ id: approvalId, approved: true })).rejects.toMatchObject({ code: 'LOUSHO_AGENT_DRIFT' });
      expect(wrong.tools.runs.send).toBe(0);

      const right = resumedBy(store, { onAgentDrift: 'error' });
      const result = await right.make(mockModel(['Sent.'], { defaultModel: 'gpt-old' })).approvals.resolve({ id: approvalId, approved: true });
      expect(result.text).toBe('Sent.');
      expect(right.tools.runs.send).toBe(1);
    });

    it('an approved call whose tool is gone is always an error and stays pending', async () => {
      const { store, approvalId } = await pausedRun();
      const model = mockModel(['never'], { defaultModel: 'gpt-old' });
      const agent = createAgent({ provider: model, instructions: 'Be brief.', tools: toolsOf(['lookup']).list, store, onAgentDrift: 'ignore' });

      await expect(agent.approvals.resolve({ id: approvalId, approved: true })).rejects.toMatchObject({ code: 'LOUSHO_RESUME_TOOL_MISSING' });
      expect(model.calls).toHaveLength(0);

      const rejected = await resumedBy(store, {}).make(mockModel(['Okay.'], { defaultModel: 'gpt-old' })).approvals.resolve({ id: approvalId, approved: false });
      expect(rejected.text).toBe('Okay.');
    });
  });
});

describe.each(stores)('a dynamic agent resumes with the model and ctx it started with (LOU-V15.2): %s', (_name, makeStore) => {
  const dynamic = (store: AgentStore, provider: ReturnType<typeof mockModel>, tools: Tools) =>
    createAgent({
      provider,
      store,
      model: (ctx) => (ctx.metadata?.tier === 'pro' ? 'big-model' : 'small-model'),
      tools: (ctx) => (ctx.metadata?.tier === 'pro' ? tools.list : tools.list.filter((t) => t.name !== 'b')),
      onAgentDrift: 'error',
    });

  it('agent.resume() uses the saved model and re-resolves tools with the saved ctx', async () => {
    const store = makeStore();
    const crashing = toolsOf(['a', 'b'], { crash: 'b' });
    const first = mockModel([calling('a'), calling('b')]);
    await expect(dynamic(store, first, crashing).send('go', { sessionId: 'job-3', metadata: { tier: 'pro' } })).rejects.toThrow('died in b');
    expect(first.calls[0].model).toBe('big-model');
    expect((await store.checkpoints!.load('job-3'))?.runConfig).toMatchObject({ model: 'big-model', ctx: { sessionId: 'job-3', metadata: { tier: 'pro' } } });

    const second = mockModel(['Finished.']);
    const result = await dynamic(store, second, toolsOf(['a', 'b'])).resume('job-3');

    expect(result?.text).toBe('Finished.');
    expect(second.calls[0].model).toBe('big-model');
  });

  it('session.resume() does the same', async () => {
    const store = makeStore();
    const first = mockModel([calling('a'), calling('b')]);
    await expect(dynamic(store, first, toolsOf(['a', 'b'], { crash: 'b' })).session({ id: 'chat' }).send('go', { metadata: { tier: 'pro' } })).rejects.toThrow('died in b');

    const second = mockModel(['Finished.']);
    const result = await dynamic(store, second, toolsOf(['a', 'b'])).session({ id: 'chat' }).resume();

    expect(result?.text).toBe('Finished.');
    expect(second.calls[0].model).toBe('big-model');
  });
});
