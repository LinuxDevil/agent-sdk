/**
 * LOU-V14: resuming after an approval streams - `streamResumeAfterApproval()`
 * and `agent.approvals.streamResolve()` / `streamAnswer()` return an AgentRun.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { AgentExecutor } from './AgentExecutor';
import { resumeAfterApproval, streamResumeAfterApproval } from './resume';
import { InMemoryApprovalStore } from './InMemoryApprovalStore';
import type { AgentEvent } from './agentEvents';
import type { AgentRun } from './agentRun';
import { AgentBuilder } from '../core';
import { ToolRegistry } from '../tools';
import { defineTool } from '../tools/defineTool';
import { createAgent } from '../createAgent';
import { memoryStore } from '../storage/agentStore';
import { mockModel, type MockTurn } from '../testing';

const callEmail: MockTurn = { toolCalls: [{ name: 'send_email', args: { to: 'sam@example.com' }, id: 'call_email' }] };

function emailTool(execute = async ({ to }: { to: string }) => `sent to ${to}`) {
  return defineTool({ name: 'send_email', description: 'Sends an email', input: z.object({ to: z.string() }), needsApproval: true, execute });
}

/** A paused executor run: the store, registry and provider to resume it with. */
async function pausedRun(script: MockTurn[]) {
  const provider = mockModel(script);
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(emailTool());
  const agent = AgentBuilder.create().setName('mailer').addTool('send_email', { tool: 'send_email', options: {} }).build();
  const approvalStore = new InMemoryApprovalStore();
  const paused = await AgentExecutor.execute({ agent, input: 'Email Sam', provider, toolRegistry, approvalStore });
  expect(paused.finishReason).toBe('awaiting-approval');
  return { provider, toolRegistry, approvalStore, id: paused.approvalId! };
}

async function collect(run: AgentRun): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

/** Event types, without the per-chunk text deltas. */
const kinds = (events: AgentEvent[]) => events.filter((e) => e.type !== 'text.delta').map((e) => e.type);
const text = (events: AgentEvent[]) => events.flatMap((e) => (e.type === 'text.delta' ? [e.text] : [])).join('');

describe('streamResumeAfterApproval (LOU-V14)', () => {
  it('streams the approved call and the continuation in order; the result equals resumeAfterApproval()', async () => {
    const streamed = await pausedRun([callEmail, 'Email sent.']);
    const plain = await pausedRun([callEmail, 'Email sent.']);

    const run = streamResumeAfterApproval({ id: streamed.id, approved: true }, streamed.approvalStore, streamed.toolRegistry, streamed.provider);
    const events = await collect(run);
    const result = await run.result;

    expect(kinds(events)).toEqual(['run.start', 'tool.start', 'tool.done', 'step.start', 'text.done', 'step.done', 'run.done']);
    expect(events.find((e) => e.type === 'tool.done')).toMatchObject({ toolCallId: 'call_email', result: 'sent to sam@example.com' });
    expect(text(events)).toBe('Email sent.');
    expect(events.every((e, i) => e.seq === i && e.runId === run.runId)).toBe(true);
    const expected = await resumeAfterApproval({ id: plain.id, approved: true }, plain.approvalStore, plain.toolRegistry, plain.provider);
    expect(result).toEqual(expected);
  });

  it('streams a rejection as tool.error, then the model reply', async () => {
    const { provider, toolRegistry, approvalStore, id } = await pausedRun([callEmail, 'OK, not sending.']);

    const run = streamResumeAfterApproval({ id, approved: false, note: 'No' }, approvalStore, toolRegistry, provider);
    const events = await collect(run);

    expect(kinds(events)).toEqual(['run.start', 'tool.start', 'tool.error', 'step.start', 'text.done', 'step.done', 'run.done']);
    expect(events.find((e) => e.type === 'tool.error')).toMatchObject({ error: { name: 'ToolRejectedError', message: 'Tool execution was rejected by the reviewer' } });
    expect((await run.result).text).toBe('OK, not sending.');
  });

  it('a continuation that pauses again emits approval.requested and saves the new approval', async () => {
    const again: MockTurn = { toolCalls: [{ name: 'send_email', args: { to: 'kim@example.com' }, id: 'call_2' }] };
    const { provider, toolRegistry, approvalStore, id } = await pausedRun([callEmail, again, 'Both sent.']);

    const run = streamResumeAfterApproval({ id, approved: true }, approvalStore, toolRegistry, provider);
    const events = await collect(run);
    const second = await run.result;

    expect(kinds(events)).toEqual(['run.start', 'tool.start', 'tool.done', 'step.start', 'tool.start', 'approval.requested', 'step.done', 'run.done']);
    expect(events.find((e) => e.type === 'approval.requested')).toMatchObject({ approvalId: second.approvalId, args: { to: 'kim@example.com' } });
    expect(events.at(-1)).toMatchObject({ type: 'run.done', finishReason: 'awaiting-approval' });
    const final = await resumeAfterApproval({ id: second.approvalId!, approved: true }, approvalStore, toolRegistry, provider);
    expect(final.text).toBe('Both sent.');
  });
});

describe('agent.approvals.streamResolve / streamAnswer (LOU-V14)', () => {
  it('streams an ask_question answer', async () => {
    const asking: MockTurn = { toolCalls: [{ name: 'ask_question', args: { question: 'Where to?' }, id: 'call_q' }] };
    const agent = createAgent({ provider: mockModel([asking, 'Booking Lisbon.']), askQuestion: true });
    const paused = await agent.send('Book a trip');

    const run = agent.approvals.streamAnswer({ id: paused.approvalId!, answer: 'Lisbon' });
    const events = await collect(run);

    expect(events.find((e) => e.type === 'tool.done')).toMatchObject({ toolName: 'ask_question', result: { answer: 'Lisbon' } });
    expect(text(events)).toBe('Booking Lisbon.');
    expect((await run.result).finishReason).toBe('stop');
  });

  it('aborting mid-continuation ends the run as aborted without another model call', async () => {
    const model = mockModel([callEmail, 'never']);
    const execute = vi.fn(
      (_args: { to: string }, { abortSignal }: { abortSignal?: AbortSignal }) =>
        new Promise<string>((resolve) => abortSignal?.addEventListener('abort', () => resolve('stopped')))
    );
    const agent = createAgent({ provider: model, tools: [defineTool({ ...emailTool(), execute })] });
    const paused = await agent.send('Email Sam');
    const controller = new AbortController();

    const run = agent.approvals.streamResolve({ id: paused.approvalId!, approved: true }, { signal: controller.signal });
    const events: AgentEvent[] = [];
    for await (const event of run) {
      events.push(event);
      if (event.type === 'tool.start') controller.abort();
    }

    expect((await run.result).finishReason).toBe('aborted');
    expect(events.at(-1)).toMatchObject({ type: 'run.done', finishReason: 'aborted' });
    expect(model.calls).toHaveLength(1);
  });

  it('input enqueued on the resumed run reaches the next model call', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const model = mockModel([callEmail, 'Sent, and noted.']);
    const tool = defineTool({ ...emailTool(), execute: async () => gate.then(() => 'sent') });
    const agent = createAgent({ provider: model, tools: [tool] });
    const paused = await agent.send('Email Sam');

    const run = agent.approvals.streamResolve({ id: paused.approvalId!, approved: true });
    expect(run.enqueue('Also cc me.')).toMatchObject({ applied: expect.any(Promise) });
    release();
    const events = await collect(run);

    expect(kinds(events)).toContain('input.applied');
    expect(JSON.stringify(model.lastCall?.messages)).toContain('Also cc me.');
  });

  it('a fresh agent on the same store streams the resume, with the model the paused run used', async () => {
    const store = memoryStore();
    const options = (provider: ReturnType<typeof mockModel>, picked: string[]) => ({
      provider,
      store,
      model: () => `model-${picked.push('x')}`,
      tools: [emailTool()],
    });
    const first = mockModel([callEmail]);
    const paused = await createAgent(options(first, [])).send('Email Sam', { sessionId: 'job' });

    const second = mockModel(['Sent.']);
    const run = createAgent(options(second, ['moved'])).approvals.streamResolve({ id: paused.approvalId!, approved: true });
    const events = await collect(run);

    expect(text(events)).toBe('Sent.');
    expect(second.calls[0].model).toBe('model-1');
    expect(await store.checkpoints?.load('job')).toMatchObject({ status: 'finished' });
  });

  it('a pause inside a session continues in that session; run.done comes after the transcript is saved', async () => {
    const agent = createAgent({ provider: mockModel([callEmail, 'Email sent.']), tools: [emailTool()] });
    const session = agent.session();
    const paused = await session.send('Email Sam');

    const run = agent.approvals.streamResolve({ id: paused.approvalId!, approved: true });
    const events = await collect(run);

    expect(events.at(-1)).toMatchObject({ type: 'run.done', finishReason: 'stop' });
    expect(session.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Email sent.' });
  });
});
