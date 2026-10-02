/** M4: a background sub-agent paused for approval pauses the lead when the lead awaits it, and resumes with the decision. */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockTurn } from '../testing';
import { SqliteStore } from '../storage/sqlite';
import type { Message } from '../providers';
import type { AgentEvent } from '../execution/agentEvents';

const bgCall = (agent: string) => ({ name: 'task', args: { agent, prompt: 'fix the bug', description: `${agent} task`, background: true } });
const bgTask = (agent: string): MockTurn => ({ toolCalls: [bgCall(agent)] });
const awaitTasks = (...taskIds: string[]): MockTurn => ({
  toolCalls: [{ name: 'agent_await', args: taskIds.length === 1 ? { taskId: taskIds[0] } : { taskIds } }],
});
const shellCall = (cmd: string): MockTurn => ({ toolCalls: [{ name: 'shell', args: { cmd } }] });

/** A coding sub-agent whose `shell` tool needs approval; `turns` are its model's. */
function coder(turns: MockTurn[], description = 'Writes code') {
  const ran: string[] = [];
  const shell = defineTool({
    name: 'shell',
    description: 'Runs a shell command',
    input: z.object({ cmd: z.string() }),
    needsApproval: true,
    execute: ({ cmd }) => (ran.push(cmd), `ran ${cmd}`),
  });
  const model = mockModel(turns);
  return { ran, model, agent: createAgent({ provider: model, instructions: 'You code.', tools: [shell], description }) };
}

/** The parsed results of the lead's tool calls named `name`, in order. */
function results(messages: readonly Message[], name: string): Record<string, unknown>[] {
  return messages
    .filter((m) => m.role === 'tool' && m.toolName === name)
    .map((m) => JSON.parse(m.content as string) as Record<string, unknown>);
}

/** What the child model was sent, per call, without its system prompt. */
const childTurns = (model: ReturnType<typeof mockModel>) =>
  model.calls.map((call) => call.messages.filter((m) => m.role !== 'system').map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`));

describe('background sub-agents that need approval (M4)', () => {
  it('agent_await pauses the lead on the child approval, listed with its sub-agent path', async () => {
    const child = coder([shellCall('npm test'), 'tests pass']);
    const lead = createAgent({ provider: mockModel([bgTask('coder'), awaitTasks('task_1'), 'done']), subagents: { coder: child.agent } });

    const paused = await lead.send('go');

    expect(paused.finishReason).toBe('awaiting-approval');
    const pending = await lead.approvals.list();
    expect(pending).toEqual([
      expect.objectContaining({ id: paused.approvalId, toolName: 'shell', args: { cmd: 'npm test' }, subagentPath: ['coder'] }),
    ]);
    expect(paused.backgroundTasks).toEqual([expect.objectContaining({ taskId: 'task_1', status: 'awaiting-approval', approvalId: paused.approvalId })]);
    // The model sees a placeholder, never the paused run.
    expect(results(paused.messages, 'agent_await')).toEqual([{ status: 'awaiting-approval', message: expect.stringContaining("approve 'shell'") }]);
    expect(child.ran).toEqual([]);
  });

  it('approving runs the child tool once; the continued lead gets the answer from agent_await', async () => {
    const child = coder([shellCall('npm test'), 'tests pass']);
    const leadModel = mockModel([bgTask('coder'), awaitTasks('task_1'), 'done']);
    const lead = createAgent({ provider: leadModel, subagents: { coder: child.agent } });
    const paused = await lead.send('go');

    const result = await lead.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(child.ran).toEqual(['npm test']);
    expect(result.finishReason).toBe('stop');
    expect(result.text).toBe('done');
    expect(results(result.messages, 'agent_await')).toEqual([
      { taskId: 'task_1', agent: 'coder', status: 'done', elapsedMs: expect.any(Number), result: expect.stringMatching(/^tests pass\n\n\[sub-agent 'coder': .*taskId 'task_1'\]$/) },
    ]);
    // The lead model saw the answer in place of the placeholder.
    expect(JSON.stringify(leadModel.calls[2].messages.at(-1))).toContain('tests pass');
    expect(await lead.approvals.list()).toEqual([]);
  });

  it('rejecting: the child sees the rejection, finishes, and the lead gets its answer', async () => {
    const child = coder([shellCall('rm -rf build'), 'I did not delete the build.']);
    const lead = createAgent({ provider: mockModel([bgTask('coder'), awaitTasks('task_1'), 'done']), subagents: { coder: child.agent } });
    const paused = await lead.send('go');

    const result = await lead.approvals.resolve({ id: paused.approvalId!, approved: false, note: 'keep the build' });

    expect(child.ran).toEqual([]);
    expect(JSON.stringify(child.model.calls[1].messages.at(-1))).toContain('rejected');
    expect(results(result.messages, 'agent_await')[0]).toMatchObject({ status: 'done', result: expect.stringMatching(/^I did not delete the build\./) });
    expect(result.text).toBe('done');
  });

  it('a child that pauses twice: two approvals in sequence, both resolvable', async () => {
    const child = coder([shellCall('npm ci'), shellCall('npm test'), 'all green']);
    const lead = createAgent({ provider: mockModel([bgTask('coder'), awaitTasks('task_1'), 'done']), subagents: { coder: child.agent } });

    const first = await lead.send('go');
    const second = await lead.approvals.resolve({ id: first.approvalId!, approved: true });

    expect(second.finishReason).toBe('awaiting-approval');
    expect(second.approvalId).not.toBe(first.approvalId);
    expect(await lead.approvals.list()).toEqual([expect.objectContaining({ id: second.approvalId, args: { cmd: 'npm test' }, subagentPath: ['coder'] })]);

    const result = await lead.approvals.resolve({ id: second.approvalId!, approved: true });

    expect(child.ran).toEqual(['npm ci', 'npm test']);
    expect(results(result.messages, 'agent_await')[0]).toMatchObject({ status: 'done', result: expect.stringMatching(/^all green/) });
    expect(result.text).toBe('done');
  });

  it('two awaited tasks both paused: two approvals in sequence, then one agent_await result with both answers', async () => {
    const backend = coder([shellCall('make api'), 'api built'], 'Builds the API');
    const frontend = coder([shellCall('make ui'), 'ui built'], 'Builds the UI');
    const leadModel = mockModel([{ toolCalls: [bgCall('backend'), bgCall('frontend')] }, awaitTasks('task_1', 'task_2'), 'done']);
    const lead = createAgent({ provider: leadModel, subagents: { backend: backend.agent, frontend: frontend.agent } });

    const first = await lead.send('go');
    expect(first.backgroundTasks?.map((t) => t.status)).toEqual(['awaiting-approval', 'awaiting-approval']);
    expect(await lead.approvals.list()).toEqual([expect.objectContaining({ args: { cmd: 'make api' }, subagentPath: ['backend'] })]);

    const second = await lead.approvals.resolve({ id: first.approvalId!, approved: true });
    expect(second.finishReason).toBe('awaiting-approval');
    expect(await lead.approvals.list()).toEqual([expect.objectContaining({ id: second.approvalId, args: { cmd: 'make ui' }, subagentPath: ['frontend'] })]);
    expect(backend.ran).toEqual(['make api']);
    expect(frontend.ran).toEqual([]);

    const result = await lead.approvals.resolve({ id: second.approvalId!, approved: true });

    expect(frontend.ran).toEqual(['make ui']);
    const [awaited] = results(result.messages, 'agent_await');
    expect((awaited.tasks as { taskId: string; status: string; result: string }[]).map((t) => [t.taskId, t.status, t.result.split('\n')[0]])).toEqual([
      ['task_1', 'done', 'api built'],
      ['task_2', 'done', 'ui built'],
    ]);
    // The lead model was called once after the decisions, with both answers.
    expect(leadModel.calls).toHaveLength(3);
  });

  it("adds the child's usage to the lead's result.usage", async () => {
    const used = { usage: { inputTokens: 1, outputTokens: 1 } };
    const child = coder([{ ...shellCall('npm test'), ...used }, { text: 'tests pass', ...used }]);
    const leadUsed = { usage: { inputTokens: 100, outputTokens: 10 } };
    const lead = createAgent({
      provider: mockModel([{ ...bgTask('coder'), ...leadUsed }, { ...awaitTasks('task_1'), ...leadUsed }, { text: 'done', ...leadUsed }]),
      subagents: { coder: child.agent },
    });
    const paused = await lead.send('go');
    expect(paused.usage).toMatchObject({ inputTokens: 201, outputTokens: 21 });

    const result = await lead.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(result.usage).toMatchObject({ inputTokens: 302, outputTokens: 32, modelCalls: 5 });
  });

  it('streams: agent.stream() reports approval.requested, and approvals.streamResolve() streams the continuation', async () => {
    const child = coder([shellCall('npm test'), 'tests pass']);
    const lead = createAgent({ provider: mockModel([bgTask('coder'), awaitTasks('task_1'), 'all done']), subagents: { coder: child.agent } });

    const run = lead.stream('go');
    const events: AgentEvent[] = [];
    for await (const event of run) events.push(event);
    const paused = await run.result;
    expect(events.filter((e) => e.type === 'approval.requested')).toEqual([
      expect.objectContaining({ approvalId: paused.approvalId, toolName: 'shell', args: { cmd: 'npm test' } }),
    ]);

    const resumed = lead.approvals.streamResolve({ id: paused.approvalId!, approved: true });
    const continued: AgentEvent[] = [];
    for await (const event of resumed) continued.push(event);
    const result = await resumed.result;

    expect(child.ran).toEqual(['npm test']);
    expect(result.text).toBe('all done');
    const awaited = continued.find((e) => e.type === 'tool.done' && e.toolName === 'agent_await');
    expect(JSON.stringify(awaited)).toContain('tests pass');
    // The resumed child reports under the re-entered agent_await call.
    const childEvents = continued.filter((e) => e.subagent?.name === 'coder');
    expect(childEvents.map((e) => e.type)).toContain('tool.done');
    expect(new Set(childEvents.map((e) => e.subagent?.toolCallId))).toEqual(new Set([awaited?.type === 'tool.done' && awaited.toolCallId]));
    expect(continued.map((e) => e.type)).toContain('text.delta');
    expect(continued.at(-1)?.type).toBe('run.done');
  });

  it('durable: a new agent over the same SQLite store resumes it; task({ taskId }) then continues the child', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lousho-m4-'));
    const file = join(dir, 'agent.db');
    try {
      const first = new SqliteStore(file);
      const before = coder([shellCall('npm test')]);
      const paused = await createAgent({ provider: mockModel([bgTask('coder'), awaitTasks('task_1')]), store: first, subagents: { coder: before.agent } }).send('go', {
        sessionId: 'job-1',
      });
      first.close();
      expect(paused.finishReason).toBe('awaiting-approval');

      const second = new SqliteStore(file);
      const after = coder(['tests pass', 'I ran npm test.']);
      const continueTask: MockTurn = { toolCalls: [{ name: 'task', args: { agent: 'coder', prompt: 'What did you run?', description: 'follow-up', taskId: 'task_1' } }] };
      const lead = createAgent({ provider: mockModel([continueTask, 'done']), store: second, subagents: { coder: after.agent } });

      await expect(lead.resume('job-1')).rejects.toMatchObject({ name: 'SessionAwaitingApprovalError', approvalId: paused.approvalId });
      const result = await lead.approvals.resolve({ id: paused.approvalId!, approved: true });
      second.close();

      expect(after.ran).toEqual(['npm test']);
      expect(result.text).toBe('done');
      expect(results(result.messages, 'agent_await')[0]).toMatchObject({ status: 'done', result: expect.stringMatching(/^tests pass/) });
      // The follow-up continued the resumed child's conversation, saved under its taskId.
      expect(childTurns(after.model)[1]).toEqual([
        'user: fix the bug',
        'assistant: ',
        'tool: "ran npm test"',
        'assistant: tests pass',
        'user: What did you run?',
      ]);
      expect(String(results(result.messages, 'task').at(-1))).toMatch(/^I ran npm test\.\n\n.*taskId 'task_1'/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
