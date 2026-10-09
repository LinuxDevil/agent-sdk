/**
 * Eve TOOLS-F19: `ApprovalDecision.remember` ("don't ask again") and `args`
 * ("approve with edits"), and `once()` remembering only a human's approval.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from './createAgent';
import { defineTool } from './tools/defineTool';
import { once } from './tools/approvalPolicies';
import { mockModel, type MockTurn } from './testing';
import type { ApprovalOutcome } from './types';

const email = (to: string, id: string): MockTurn => ({ toolCalls: [{ name: 'send_email', args: { to }, id }] });

function emailTool(needsApproval: boolean | ((args: unknown, ctx: never) => ApprovalOutcome) = true) {
  const sent: string[] = [];
  const tool = defineTool({
    name: 'send_email',
    description: 'Sends an email',
    input: z.object({ to: z.string().email() }),
    needsApproval: needsApproval as never,
    execute: async ({ to }) => {
      sent.push(to);
      return `sent to ${to}`;
    },
  });
  return { tool, sent };
}

describe('once() and a non-human approve callback (Eve TOOLS-F19)', () => {
  it("asks the callback again for each call: its yes is not remembered", async () => {
    const { tool, sent } = emailTool(once());
    const approve = vi.fn(() => true);
    const agent = createAgent({ provider: mockModel([email('a@x.io', 'c1'), email('b@x.io', 'c2'), 'done']), tools: [tool], approve });
    const result = await agent.session({ id: 's' }).send('go');
    expect(result.text).toBe('done');
    expect(sent).toEqual(['a@x.io', 'b@x.io']);
    expect(approve).toHaveBeenCalledTimes(2);
  });

  it('a callback that says no the second time stops the second call', async () => {
    const { tool, sent } = emailTool(once());
    let asked = 0;
    const agent = createAgent({ provider: mockModel([email('a@x.io', 'c1'), email('b@x.io', 'c2'), 'done']), tools: [tool], approve: () => ++asked === 1 });
    await agent.session({ id: 's' }).send('go');
    expect(asked).toBe(2);
    expect(sent).toEqual(['a@x.io']);
  });

  it("still remembers a human's approval", async () => {
    const { tool, sent } = emailTool(once());
    const agent = createAgent({ provider: mockModel([email('a@x.io', 'c1'), email('b@x.io', 'c2'), 'done']), tools: [tool] });
    const paused = await agent.session({ id: 's' }).send('go');
    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
    expect(result.finishReason).toBe('stop');
    expect(sent).toEqual(['a@x.io', 'b@x.io']);
  });
});

describe("ApprovalDecision.remember: 'session' (Eve TOOLS-F19)", () => {
  it('approves later identical calls in the session without asking; other arguments still ask', async () => {
    const { tool, sent } = emailTool(true);
    const model = mockModel([email('a@x.io', 'c1'), 'first', email('a@x.io', 'c2'), 'second', email('b@x.io', 'c3'), 'third']);
    const agent = createAgent({ provider: model, tools: [tool] });
    const session = agent.session({ id: 's' });

    const paused = await session.send('mail a');
    expect(paused.finishReason).toBe('awaiting-approval');
    expect((await agent.approvals.resolve({ id: paused.approvalId!, approved: true, remember: 'session' })).text).toBe('first');

    const again = await session.send('mail a again');
    expect(again.finishReason).toBe('stop');
    expect(again.text).toBe('second');
    expect(sent).toEqual(['a@x.io', 'a@x.io']);

    const other = await session.send('mail b');
    expect(other.finishReason).toBe('awaiting-approval');
    expect(sent).toEqual(['a@x.io', 'a@x.io']);
  });

  it('without remember, the next identical call asks again', async () => {
    const { tool } = emailTool(true);
    const agent = createAgent({ provider: mockModel([email('a@x.io', 'c1'), 'first', email('a@x.io', 'c2'), 'second']), tools: [tool] });
    const session = agent.session({ id: 's' });
    const paused = await session.send('mail a');
    await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
    expect((await session.send('again')).finishReason).toBe('awaiting-approval');
  });
});

describe('ApprovalDecision.args: approve with edits (Eve TOOLS-F19)', () => {
  it('runs the tool with the edited arguments and rewrites the call in the transcript', async () => {
    const { tool, sent } = emailTool(true);
    const model = mockModel([email('wrong@x.io', 'c1'), 'done']);
    const agent = createAgent({ provider: model, tools: [tool] });
    const paused = await agent.send('mail');
    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true, args: { to: 'right@x.io' } });
    expect(sent).toEqual(['right@x.io']);
    const call = result.messages.find((m) => m.role === 'assistant' && m.toolCalls?.length)?.toolCalls?.[0];
    expect(JSON.parse(call!.function.arguments)).toEqual({ to: 'right@x.io' });
    // The model's next call saw the edited call and its result.
    const seen = model.calls[1]?.messages.find((m) => m.role === 'assistant' && m.toolCalls?.length)?.toolCalls?.[0];
    expect(JSON.parse(seen!.function.arguments)).toEqual({ to: 'right@x.io' });
  });

  it('refuses arguments the schema rejects and leaves the approval pending', async () => {
    const { tool, sent } = emailTool(true);
    const agent = createAgent({ provider: mockModel([email('a@x.io', 'c1'), 'done']), tools: [tool] });
    const paused = await agent.send('mail');
    await expect(agent.approvals.resolve({ id: paused.approvalId!, approved: true, args: { to: 'not-an-email' } })).rejects.toMatchObject({
      code: 'LOUSHO_TOOL_ARGS_INVALID',
    });
    expect(sent).toEqual([]);
    expect((await agent.approvals.list()).map((entry) => entry.id)).toEqual([paused.approvalId]);
    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true, args: { to: 'ok@x.io' } });
    expect(result.text).toBe('done');
    expect(sent).toEqual(['ok@x.io']);
  });

  it('ignores args on a rejection', async () => {
    const { tool, sent } = emailTool(true);
    const agent = createAgent({ provider: mockModel([email('a@x.io', 'c1'), 'ok']), tools: [tool] });
    const paused = await agent.send('mail');
    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: false, args: { to: 'x' } });
    expect(result.text).toBe('ok');
    expect(sent).toEqual([]);
  });
});
