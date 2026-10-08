/**
 * LOU-V8: `session.stream()` streams a session turn and persists it when the run is done.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockRequest } from '../testing';
import type { AgentEvent } from '../execution/agentEvents';
import type { AgentRun } from '../execution/agentRun';
import type { SessionStore } from './index';
import { MemorySessionStore } from './index';

async function collect(run: AgentRun): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

const roles = (messages: readonly { role: string }[]): string[] => messages.map((m) => m.role);

const emailTool = () =>
  defineTool({
    name: 'send_email',
    description: 'Sends an email',
    input: z.object({ to: z.string() }),
    needsApproval: true,
    execute: async ({ to }) => `sent to ${to}`,
  });
const callEmail = { toolCalls: [{ name: 'send_email', args: { to: 'sam@example.com' }, id: 'call_email' }] };

describe('AgentSession.stream()', () => {
  it('streams the turn in order and has saved it when the run is done', async () => {
    const store = new MemorySessionStore();
    const session = createAgent({ provider: mockModel(['Nice to meet you, Ali.']) }).session({ id: 's1', store });

    const run = session.stream('My name is Ali.');
    const events: AgentEvent[] = [];
    for await (const event of run) {
      events.push(event);
      // The transcript is complete by the time run.done is delivered.
      if (event.type === 'run.done') expect(roles((await store.load('s1')) ?? [])).toEqual(['user', 'assistant']);
    }

    expect(events.map((e) => e.type)).toEqual([
      'run.start',
      'step.start',
      ...events.filter((e) => e.type === 'text.delta').map(() => 'text.delta'),
      'text.done',
      'step.done',
      'run.done',
    ]);
    expect(events.filter((e) => e.type === 'text.delta').length).toBeGreaterThan(1);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(new Set(events.map((e) => e.runId))).toEqual(new Set([run.runId]));
    const result = await run.result;
    expect(result.text).toBe('Nice to meet you, Ali.');
    expect(events.at(-1)).toMatchObject({ type: 'run.done', finishReason: 'stop', text: 'Nice to meet you, Ali.' });
    expect(await store.load('s1')).toEqual([
      { role: 'user', content: 'My name is Ali.' },
      expect.objectContaining({ role: 'assistant', content: 'Nice to meet you, Ali.' }),
    ]);
    expect(session.messages).toEqual(await store.load('s1'));
  });

  it('shows a second stream() the first turn, and mixes with send()', async () => {
    const model = mockModel(['Nice to meet you, Ali.', 'Your name is Ali.', 'Yes.']);
    const session = createAgent({ prompt: 'Be brief.', provider: model }).session();

    await collect(session.stream('My name is Ali.'));
    await collect(session.stream('What is my name?'));
    await session.send('Sure?');

    expect(model.calls[1].messages.map((m) => `${m.role}:${m.content}`)).toEqual([
      'system:Be brief.',
      'user:My name is Ali.',
      'assistant:Nice to meet you, Ali.',
      'user:What is my name?',
    ]);
    expect(roles(session.messages)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
  });

  it('continues a stored conversation and queues behind an earlier send()', async () => {
    const store = new MemorySessionStore();
    await createAgent({ provider: mockModel(['Hi Ali.']) }).session({ id: 'resume', store }).send('I am Ali.');
    const model = mockModel(['one', 'two']);
    const session = createAgent({ provider: model }).session({ id: 'resume', store });

    const first = session.send('first');
    const run = session.stream('second');
    await Promise.all([first, run.result]);

    expect(convoTexts(model.calls[1].messages)).toEqual(['I am Ali.', 'Hi Ali.', 'first', 'one', 'second']);
    expect(roles(session.messages)).toHaveLength(6);
  });

  it('works without iterating, and an iterated run can only be read once', async () => {
    const session = createAgent({ provider: mockModel(['a', 'b']) }).session();

    const quiet = session.stream('one');
    expect((await quiet.result).text).toBe('a');
    expect(session.messages).toHaveLength(2);

    const run = session.stream('two');
    await collect(run);
    await expect(collect(run)).rejects.toThrow(/only be iterated once/);
    await expect(collect(run)).rejects.toMatchObject({ code: 'LOUSHO_RUN_ALREADY_ITERATED' });
  });

  it('keeps only the tool calls that ran when a stream is aborted by its signal (B4)', async () => {
    const controller = new AbortController();
    const slow = defineTool({
      name: 'slow',
      description: 'slow',
      input: z.object({}),
      execute: async () => {
        controller.abort();
        return 'done';
      },
    });
    const model = mockModel(['hello', { toolCalls: [{ name: 'slow' }, { name: 'slow' }] }, 'next']);
    const session = createAgent({ provider: model, tools: [slow] }).session();
    await session.send('hi');
    const before = session.messages;

    const run = session.stream('go', { signal: controller.signal });
    const events = await collect(run);

    expect((await run.result).finishReason).toBe('aborted');
    expect(events.at(-1)).toMatchObject({ type: 'run.done', finishReason: 'aborted' });
    expect(session.messages.slice(0, before.length)).toEqual(before);
    expect(roles(session.messages.slice(before.length))).toEqual(['user', 'assistant', 'tool', 'tool']);
    await session.send('still there?');
    expect(roles(model.calls[2].messages.filter((m) => m.role !== 'system'))).toEqual(['user', 'assistant', 'user', 'assistant', 'tool', 'tool', 'user']);
  });

  it('keeps the tool call that ran when the loop is exited early (B4)', async () => {
    const wait = defineTool({
      name: 'wait',
      description: 'waits',
      input: z.object({}),
      execute: () => new Promise<string>((resolve) => setTimeout(() => resolve('waited'), 20)),
    });
    const model = mockModel(['first reply', { toolCalls: [{ name: 'wait' }] }, 'never sent', 'ok']);
    const session = createAgent({ provider: model, tools: [wait] }).session();
    await session.send('hi');
    const before = session.messages;

    const run = session.stream('wait for it');
    for await (const event of run) {
      if (event.type === 'tool.start') break;
    }

    expect((await run.result).finishReason).toBe('aborted');
    expect(session.messages.slice(0, before.length)).toEqual(before);
    expect(session.messages.slice(before.length).map((m) => (m.role === 'tool' ? m.content : m.role))).toEqual(['user', 'assistant', '"waited"']);
    expect((await session.send('next')).text).toBe('never sent');
  });

  it('leaves the transcript unchanged and reports a failed run', async () => {
    const model = mockModel(['hello', { error: new Error('provider down') }, 'back']);
    const session = createAgent({ provider: model }).session();
    await session.send('hi');
    const before = session.messages;

    const run = session.stream('again');
    const events = await collect(run);

    await expect(run.result).rejects.toThrow('provider down');
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'run.done', finishReason: 'error' });
    expect(session.messages).toEqual(before);
    expect((await session.send('hello?')).text).toBe('back');
  });

  it('ends with error and run.done when the history cannot be loaded or the turn cannot be saved', async () => {
    const memory = new MemorySessionStore();
    const broken: SessionStore = {
      load: () => Promise.reject(new Error('load failed')),
      save: (id, messages) => memory.save(id, messages),
      delete: (id) => memory.delete(id),
    };
    const loadFails = createAgent({ provider: mockModel(['x']) }).session({ store: broken });
    const run = loadFails.stream('hi');
    const events = await collect(run);
    await expect(run.result).rejects.toThrow('load failed');
    expect(events.map((e) => [e.type, e.seq])).toEqual([
      ['error', 0],
      ['run.done', 1],
    ]);

    const saveFails = createAgent({ provider: mockModel(['x']) }).session({
      store: { ...memory, load: (id) => memory.load(id), save: () => Promise.reject(new Error('disk full')), delete: (id) => memory.delete(id) },
    });
    const saving = saveFails.stream('hi');
    const savingEvents = await collect(saving);
    await expect(saving.result).rejects.toThrow('disk full');
    expect(savingEvents.slice(-2).map((e) => e.type)).toEqual(['error', 'run.done']);
    expect(savingEvents.at(-1)).toMatchObject({ finishReason: 'error' });
    expect(savingEvents.map((e) => e.seq)).toEqual(savingEvents.map((_, i) => i));
  });

  it('saves a paused turn and resumes it with approvals.resolve()', async () => {
    const execute = vi.fn();
    const tool = defineTool({
      name: 'send_email',
      description: 'Sends an email',
      input: z.object({ to: z.string() }),
      needsApproval: true,
      execute: async ({ to }) => {
        execute(to);
        return `sent to ${to}`;
      },
    });
    const model = mockModel([callEmail, 'Email sent.', 'You asked me to email Sam.']);
    const agent = createAgent({ provider: model, tools: [tool] });
    const session = agent.session();

    const run = session.stream('Email Sam');
    const events = await collect(run);
    const paused = await run.result;

    expect(paused.finishReason).toBe('awaiting-approval');
    expect(events.map((e) => e.type)).toContain('approval.requested');
    expect(events.at(-1)).toMatchObject({ type: 'run.done', finishReason: 'awaiting-approval' });
    expect(execute).not.toHaveBeenCalled();
    expect(roles(session.messages)).toEqual(['user']);

    await agent.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(execute).toHaveBeenCalledWith('sam@example.com');
    expect(roles(session.messages)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    const followUp = await collect(session.stream('What did I ask?'));
    expect(followUp.at(-1)).toMatchObject({ type: 'run.done', text: 'You asked me to email Sam.' });
    expect(model.calls[2].messages.map((m) => m.content)).toContain('Email sent.');
  });

  it('binds a pause to its session as soon as approval.requested is seen', async () => {
    const model = mockModel([callEmail, 'Email sent.']);
    const agent = createAgent({ provider: model, tools: [emailTool()] });
    const session = agent.session();

    let resolved: Promise<unknown> | undefined;
    for await (const event of session.stream('Email Sam')) {
      if (event.type === 'approval.requested') resolved = agent.approvals.resolve({ id: event.approvalId, approved: true });
    }
    await resolved;

    expect(roles(session.messages)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });
});

function convoTexts(messages: MockRequest['messages']): unknown[] {
  return messages.filter((m) => m.role !== 'system').map((m) => m.content);
}
