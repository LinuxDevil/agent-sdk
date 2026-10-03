/**
 * M10c: a run paused inside a sub-agent compares the sub-agent's saved
 * fingerprint with its current definition on resume, under the lead's
 * `onAgentDrift`; a refused resume leaves the lead's approval (and session)
 * paused, so fixing the sub-agent and deciding again finishes the run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgent, type CreateAgentBase, type SimpleAgent } from '../createAgent';

/** Extra createAgent options a test adds on top of the provider and instructions it sets itself. */
type ExtraConfig = Partial<CreateAgentBase>;
import { defineTool } from '../tools/defineTool';
import { memoryStore, type AgentStore } from '../storage/agentStore';
import { SqliteStore } from '../storage/sqlite';
import { mockModel, type MockTurn } from '../testing';
import type { AgentEvent } from './agentEvents';

const stores: Array<[string, () => AgentStore]> = [
  ['in-memory store', () => memoryStore()],
  ['SQLite store', () => new SqliteStore(':memory:')],
];

const taskCall = (agent: string): MockTurn => ({ toolCalls: [{ name: 'task', args: { agent, prompt: 'Do it.', description: 'a task' } }] });
const sendCall: MockTurn = { toolCalls: [{ name: 'send', args: { to: 'ana' } }] };

interface ChildOptions {
  instructions?: string;
  defaultModel?: string;
  /** Whether the sub-agent has the `send` tool (needs approval). */
  withSend?: boolean;
  subagents?: Record<string, SimpleAgent>;
}

/** Records every `send` that ran. */
function sender(sent: string[]) {
  return defineTool({
    name: 'send',
    description: 'Sends a message',
    input: z.object({ to: z.string() }),
    needsApproval: true,
    execute: async ({ to }) => {
      sent.push(to);
      return `sent to ${to}`;
    },
  });
}

function child(turns: MockTurn[], sent: string[], { instructions = 'You send mail.', defaultModel = 'gpt-old', withSend = true, subagents }: ChildOptions = {}) {
  return createAgent({
    provider: mockModel(turns, { defaultModel }),
    instructions,
    description: 'A sub-agent',
    ...(withSend && { tools: [sender(sent)] }),
    ...(subagents && { subagents }),
  });
}

function lead(store: AgentStore, subagents: Record<string, SimpleAgent>, turns: MockTurn[], config: ExtraConfig = {}) {
  const events: AgentEvent[] = [];
  const agent = createAgent({
    provider: mockModel(turns, { defaultModel: 'lead-model' }),
    instructions: 'You lead.',
    subagents,
    store,
    onEvent: (event) => events.push(event),
    ...config,
  });
  return { agent, events };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(stores)('resuming a run paused inside a sub-agent that changed (M10c): %s', (_name, makeStore) => {
  /** A lead whose sub-agent `mailer` paused on `send`. */
  async function paused(sessionId?: string) {
    const store = makeStore();
    const sent: string[] = [];
    const { agent } = lead(store, { mailer: child([sendCall], sent) }, [taskCall('mailer')]);
    const result = await agent.send('go', sessionId ? { sessionId } : {});
    expect(result.finishReason).toBe('awaiting-approval');
    return { store, sent, approvalId: result.approvalId! };
  }

  /** A new lead instance over `store` with `mailer` as defined by `options`. */
  const resumer = (store: AgentStore, sent: string[], options: ChildOptions, config: ExtraConfig = {}) =>
    lead(store, { mailer: child(['sent!'], sent, options) }, ['done'], config);

  it("'error': a changed sub-agent's instructions refuse the resume; the approval stays pending and resolves with the old definition", async () => {
    const { store, sent, approvalId } = await paused();
    const changed = resumer(store, sent, { instructions: 'You send mail, politely.' }, { onAgentDrift: 'error' });

    await expect(changed.agent.approvals.resolve({ id: approvalId, approved: true })).rejects.toMatchObject({
      code: 'LOUSHO_AGENT_DRIFT',
      detail: expect.stringContaining('instructions changed'),
    });
    expect(sent).toEqual([]);
    expect((await changed.agent.approvals.list()).map((request) => request.id)).toEqual([approvalId]);

    const fixed = resumer(store, sent, {}, { onAgentDrift: 'error' });
    const result = await fixed.agent.approvals.resolve({ id: approvalId, approved: true });

    expect(result.text).toBe('done');
    expect(sent).toEqual(['ana']);
  });

  it("'warn': warns once, reports agent.drift with the sub-agent, and finishes", async () => {
    const { store, sent, approvalId } = await paused();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const changed = resumer(store, sent, { instructions: 'Changed.' }, { onAgentDrift: 'warn' });

    const result = await changed.agent.approvals.resolve({ id: approvalId, approved: true });

    expect(result.text).toBe('done');
    expect(sent).toEqual(['ana']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('instructions changed'));
    const drifts = changed.events.filter((event) => event.type === 'agent.drift');
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({ instructions: true, subagent: { name: 'mailer', depth: 1 } });
  });

  it("the default is 'warn'", async () => {
    const { store, sent, approvalId } = await paused();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await resumer(store, sent, { instructions: 'Changed.' }).agent.approvals.resolve({ id: approvalId, approved: true });

    expect(result.text).toBe('done');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("'ignore': no warning and no event", async () => {
    const { store, sent, approvalId } = await paused();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const changed = resumer(store, sent, { instructions: 'Changed.' }, { onAgentDrift: 'ignore' });

    const result = await changed.agent.approvals.resolve({ id: approvalId, approved: true });

    expect(result.text).toBe('done');
    expect(sent).toEqual(['ana']);
    expect(warn).not.toHaveBeenCalled();
    expect(changed.events.some((event) => event.type === 'agent.drift')).toBe(false);
  });

  it("a changed sub-agent model is detected", async () => {
    const { store, sent, approvalId } = await paused();
    const changed = resumer(store, sent, { defaultModel: 'gpt-new' }, { onAgentDrift: 'error' });

    await expect(changed.agent.approvals.resolve({ id: approvalId, approved: true })).rejects.toMatchObject({
      code: 'LOUSHO_AGENT_DRIFT',
      detail: expect.stringContaining('model gpt-old -> gpt-new'),
    });
    expect(sent).toEqual([]);
  });

  it("a sub-agent without the approved call's tool is LOUSHO_RESUME_TOOL_MISSING, whatever the mode, and the approval stays pending", async () => {
    const { store, sent, approvalId } = await paused();

    for (const onAgentDrift of ['ignore', 'warn', 'error'] as const) {
      const without = resumer(store, sent, { withSend: false }, { onAgentDrift });
      await expect(without.agent.approvals.resolve({ id: approvalId, approved: true })).rejects.toMatchObject({
        code: 'LOUSHO_RESUME_TOOL_MISSING',
        detail: expect.stringContaining("'send'"),
      });
    }

    const result = await resumer(store, sent, {}).agent.approvals.resolve({ id: approvalId, approved: true });
    expect(result.text).toBe('done');
    expect(sent).toEqual(['ana']);
  });

  it('no drift: no warning, and the run finishes', async () => {
    const { store, sent, approvalId } = await paused();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const same = resumer(store, sent, {}, { onAgentDrift: 'error' });

    const result = await same.agent.approvals.resolve({ id: approvalId, approved: true });

    expect(result.text).toBe('done');
    expect(sent).toEqual(['ana']);
    expect(warn).not.toHaveBeenCalled();
    expect(same.events.some((event) => event.type === 'agent.drift')).toBe(false);
  });

  describe('two levels deep (lead -> manager -> mailer)', () => {
    async function pausedTwoDeep() {
      const store = makeStore();
      const sent: string[] = [];
      const manager = child([taskCall('mailer')], sent, { withSend: false, subagents: { mailer: child([sendCall], sent) } });
      const result = await lead(store, { manager }, [taskCall('manager')], { maxSubagentDepth: 2 }).agent.send('go');
      expect(result.finishReason).toBe('awaiting-approval');
      return { store, sent, approvalId: result.approvalId! };
    }
    const resumerTwoDeep = (store: AgentStore, sent: string[], mailer: ChildOptions, config: ExtraConfig) =>
      lead(store, { manager: child(['managed'], sent, { withSend: false, subagents: { mailer: child(['sent!'], sent, mailer) } }) }, ['done'], { maxSubagentDepth: 2, ...config });

    it("'error': the grandchild's drift refuses the resume with the lead's mode; fixed, it finishes", async () => {
      const { store, sent, approvalId } = await pausedTwoDeep();
      const changed = resumerTwoDeep(store, sent, { instructions: 'Changed.' }, { onAgentDrift: 'error' });

      await expect(changed.agent.approvals.resolve({ id: approvalId, approved: true })).rejects.toMatchObject({ code: 'LOUSHO_AGENT_DRIFT' });
      expect(sent).toEqual([]);

      const result = await resumerTwoDeep(store, sent, {}, { onAgentDrift: 'error' }).agent.approvals.resolve({ id: approvalId, approved: true });
      expect(result.text).toBe('done');
      expect(sent).toEqual(['ana']);
    });

    it("'warn': agent.drift names the grandchild under its parent", async () => {
      const { store, sent, approvalId } = await pausedTwoDeep();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const changed = resumerTwoDeep(store, sent, { defaultModel: 'gpt-new' }, { onAgentDrift: 'warn' });

      const result = await changed.agent.approvals.resolve({ id: approvalId, approved: true });

      expect(result.text).toBe('done');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(changed.events.filter((event) => event.type === 'agent.drift')).toEqual([
        expect.objectContaining({ model: { from: 'gpt-old', to: 'gpt-new' }, subagent: expect.objectContaining({ name: 'mailer', depth: 2, parent: expect.objectContaining({ name: 'manager' }) }) }),
      ]);
    });
  });

  it('durable: a new agent over the same store refuses with a changed sub-agent and the session stays paused', async () => {
    const { store, sent, approvalId } = await paused('job-1');
    const before = await store.checkpoints!.load('job-1');
    expect(before).toMatchObject({ status: 'awaiting-approval', approvalId });
    const changed = resumer(store, sent, { instructions: 'Changed.' }, { onAgentDrift: 'error' });

    await expect(changed.agent.approvals.resolve({ id: approvalId, approved: true })).rejects.toMatchObject({ code: 'LOUSHO_AGENT_DRIFT' });
    expect(await store.checkpoints!.load('job-1')).toEqual(before);
    await expect(changed.agent.resume('job-1')).rejects.toMatchObject({ approvalId });

    const fixed = resumer(store, sent, {}, { onAgentDrift: 'error' });
    const result = await fixed.agent.approvals.resolve({ id: approvalId, approved: true });
    expect(result.text).toBe('done');
    expect(sent).toEqual(['ana']);
    expect((await store.checkpoints!.load('job-1'))?.status).toBe('finished');
  });
});
