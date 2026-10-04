/**
 * LOU-D21: createAgent() agents pause for approval (in-memory store by
 * default) and resume with `agent.approvals.resolve()` or an `approve` callback.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from './createAgent';
import { defineTool } from './tools/defineTool';
import { InMemoryApprovalStore } from './execution/InMemoryApprovalStore';
import { mockModel } from './testing';
import type { Message } from './providers';

function emailTool() {
  const execute = vi.fn(async ({ to }: { to: string }) => `sent to ${to}`);
  const tool = defineTool({
    name: 'send_email',
    description: 'Sends an email',
    input: z.object({ to: z.string() }),
    needsApproval: true,
    execute,
  });
  return { tool, execute };
}

const callEmail = { toolCalls: [{ name: 'send_email', args: { to: 'sam@example.com' }, id: 'call_email' }] };

function toolResult(messages: readonly Message[]): Message | undefined {
  return messages.find((m) => m.role === 'tool' && m.toolCallId === 'call_email');
}

describe('createAgent approvals (LOU-D21)', () => {
  it('pauses on a needsApproval tool, then approving runs the tool and finishes', async () => {
    const { tool, execute } = emailTool();
    const agent = createAgent({ provider: mockModel([callEmail, 'Email sent.']), tools: [tool] });

    const paused = await agent.send('Email Sam');

    expect(paused.finishReason).toBe('awaiting-approval');
    expect(paused.approvalId).toBeDefined();
    expect(execute).not.toHaveBeenCalled();
    const [pending] = await agent.approvals.list();
    expect(pending).toMatchObject({ id: paused.approvalId, toolName: 'send_email', args: { to: 'sam@example.com' } });

    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.finishReason).toBe('stop');
    expect(result.text).toBe('Email sent.');
    expect(toolResult(result.messages)?.content).toBe(JSON.stringify('sent to sam@example.com'));
    expect(await agent.approvals.list()).toEqual([]);
    await expect(agent.approvals.resolve({ id: paused.approvalId!, approved: true })).rejects.toThrow(/No pending approval/);
  });

  it('rejecting gives the model a structured rejection and does not run the tool', async () => {
    const { tool, execute } = emailTool();
    const model = mockModel([callEmail, 'OK, I will not send it.']);
    const agent = createAgent({ provider: model, tools: [tool] });

    const paused = await agent.send('Email Sam');
    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: false, note: 'Not today' });

    expect(execute).not.toHaveBeenCalled();
    expect(result.text).toBe('OK, I will not send it.');
    const rejection = toolResult(model.calls[1].messages as Message[]);
    expect(rejection?.isError).toBe(true);
    expect(JSON.parse(rejection?.content as string)).toEqual({
      error: 'ToolRejectedError',
      toolName: 'send_email',
      message: 'Tool execution was rejected by the reviewer',
      kind: 'rejected',
      note: 'Not today',
    });
  });

  it('an approve callback decides at once, without pausing', async () => {
    const approved = emailTool();
    const approve = vi.fn(() => true);
    const yes = createAgent({ provider: mockModel([callEmail, 'Sent.']), tools: [approved.tool], approve });

    const result = await yes.send('Email Sam');

    expect(result.finishReason).toBe('stop');
    expect(result.text).toBe('Sent.');
    expect(approved.execute).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'send_email', toolCallId: 'call_email', args: { to: 'sam@example.com' } })
    );

    const denied = emailTool();
    const no = createAgent({ provider: mockModel([callEmail, 'Not sent.']), tools: [denied.tool], approve: async () => false });

    const rejected = await no.send('Email Sam');

    expect(rejected.finishReason).toBe('stop');
    expect(denied.execute).not.toHaveBeenCalled();
    expect(toolResult(rejected.messages)?.isError).toBe(true);
    expect(await no.approvals.list()).toEqual([]);
  });

  it('gives each agent its own default store', async () => {
    const first = createAgent({ provider: mockModel([callEmail]), tools: [emailTool().tool] });
    const second = createAgent({ provider: mockModel([callEmail]), tools: [emailTool().tool] });

    const paused = await first.send('Email Sam');

    expect(await second.approvals.list()).toEqual([]);
    await expect(second.approvals.resolve({ id: paused.approvalId!, approved: true })).rejects.toThrow(/No pending approval/);
    expect(await first.approvals.list()).toHaveLength(1);
  });

  it('uses the approvalStore option when given', async () => {
    const approvalStore = new InMemoryApprovalStore();
    const save = vi.spyOn(approvalStore, 'save');
    const agent = createAgent({ provider: mockModel([callEmail, 'Done.']), tools: [emailTool().tool], approvalStore });

    const paused = await agent.send('Email Sam');

    expect(save).toHaveBeenCalledTimes(1);
    expect(await approvalStore.resolve(paused.approvalId!)).toMatchObject({ pending: { toolName: 'send_email' } });
  });

  it('get() returns a pause this process did not make, through a shared approvalStore, without resolving it (#280)', async () => {
    const approvalStore = new InMemoryApprovalStore();
    const { tool, execute } = emailTool();
    const first = createAgent({ provider: mockModel([callEmail, 'Email sent.']), tools: [tool], approvalStore });
    const paused = await first.send('Email Sam');

    // "after a restart": another agent over the same store does not list the pause, but get() finds it
    const second = createAgent({ provider: mockModel(['unused']), tools: [emailTool().tool], approvalStore });
    expect(await second.approvals.list()).toEqual([]);
    expect(await second.approvals.get(paused.approvalId!)).toMatchObject({ id: paused.approvalId, toolName: 'send_email', args: { to: 'sam@example.com' } });
    expect(await second.approvals.get('nope')).toBeUndefined();

    // the read did not resolve it: either agent can still decide it
    const result = await first.approvals.resolve({ id: paused.approvalId!, approved: true });
    expect(result.text).toBe('Email sent.');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await second.approvals.get(paused.approvalId!)).toBeUndefined();
  });

  it('resolving a pause from a session continues that session', async () => {
    const { tool } = emailTool();
    const model = mockModel([callEmail, 'Email sent.', 'You asked me to email Sam.']);
    const agent = createAgent({ provider: model, tools: [tool] });
    const session = agent.session();

    const paused = await session.send('Email Sam');
    expect(paused.finishReason).toBe('awaiting-approval');
    await agent.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(session.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    const followUp = await session.send('What did I ask?');
    expect(followUp.text).toBe('You asked me to email Sam.');
    const sent = model.calls[2].messages.map((m) => m.content);
    expect(sent).toContain('Email Sam');
    expect(sent).toContain('Email sent.');
    expect(sent).toContain(JSON.stringify('sent to sam@example.com'));
  });

  it("pauses on a sub-agent's tool and resumes it through the lead's approvals", async () => {
    const { tool, execute } = emailTool();
    const mailer = createAgent({ provider: mockModel([callEmail, 'Mailed.']), tools: [tool], description: 'Sends mail' });
    const task = { name: 'task', args: { agent: 'mailer', prompt: 'Email Sam', description: 'mail' } };
    const lead = createAgent({ provider: mockModel([{ toolCalls: [task] }, 'All done.']), subagents: { mailer } });

    const paused = await lead.send('Email Sam via the mailer');
    const [pending] = await lead.approvals.list();
    expect(pending).toMatchObject({ toolName: 'send_email', subagentPath: ['mailer'] });

    const result = await lead.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('All done.');
  });

  it('stream() ends at the pause instead of throwing', async () => {
    const agent = createAgent({ provider: mockModel([callEmail, 'Sent.']), tools: [emailTool().tool] });

    const run = agent.stream('Email Sam');
    for await (const event of run) void event;
    const paused = await run.result;

    expect(paused.finishReason).toBe('awaiting-approval');
    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
    expect(result.text).toBe('Sent.');
  });
});
