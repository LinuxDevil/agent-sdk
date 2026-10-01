/**
 * LOU-X9: the built-in `ask_question` tool pauses the run through the
 * approval mechanism until a human answers (or declines), durably.
 */
import { describe, it, expect, vi } from 'vitest';
import { createAgent } from '../../createAgent';
import { memoryStore, type AgentStore } from '../../storage/agentStore';
import { SqliteStore } from '../../storage/sqlite';
import { mockModel, type MockTurn } from '../../testing';
import type { ApproveToolCall } from '../../createAgentApprovals';
import type { AgentEvent } from '../../execution/agentEvents';
import type { Message } from '../../providers';
import { askQuestionTool } from './askQuestion';

const asking = (args: Record<string, unknown>): MockTurn => ({ toolCalls: [{ name: 'ask_question', args, id: 'call_q' }] });
const whichCity = asking({ question: 'Which city?', options: ['Porto', 'Lisbon'] });

/** The `ask_question` result the model saw on its last call. */
function seen(model: ReturnType<typeof mockModel>): { content: unknown; isError?: boolean } {
  const message = (model.lastCall?.messages as Message[]).find((m) => m.role === 'tool' && m.toolCallId === 'call_q');
  return { content: JSON.parse(message?.content as string), isError: message?.isError };
}

describe('ask_question (LOU-X9)', () => {
  it("pauses with kind: 'question'; answer() continues and the model sees the answer", async () => {
    const model = mockModel([asking({ question: 'Where to?' }), 'Booking Lisbon.']);
    const agent = createAgent({ provider: model, askQuestion: true });

    const paused = await agent.send('Book a trip');

    expect(paused.finishReason).toBe('awaiting-approval');
    expect(await agent.approvals.list()).toEqual([
      expect.objectContaining({ id: paused.approvalId, toolName: 'ask_question', kind: 'question', question: { text: 'Where to?' } }),
    ]);
    const result = await agent.approvals.answer({ id: paused.approvalId!, answer: 'Lisbon' });

    expect(result.text).toBe('Booking Lisbon.');
    expect(seen(model)).toEqual({ content: { answer: 'Lisbon' }, isError: undefined });
  });

  it('resolve({ approved: true, note }) answers too, and an answer matching an option gives its index', async () => {
    const model = mockModel([whichCity, 'Lisbon it is.']);
    const agent = createAgent({ provider: model, askQuestion: true });

    const paused = await agent.send('Book a trip');
    await agent.approvals.resolve({ id: paused.approvalId!, approved: true, note: 'lisbon' });

    expect(seen(model).content).toEqual({ answer: 'lisbon', option: 1 });
  });

  it('declining gives the model a structured rejection', async () => {
    const model = mockModel([whichCity, 'No problem.']);
    const agent = createAgent({ provider: model, askQuestion: true });

    const paused = await agent.send('Book a trip');
    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: false, note: 'Not now' });

    expect(result.text).toBe('No problem.');
    expect(seen(model)).toEqual({
      content: {
        error: 'ToolRejectedError',
        toolName: 'ask_question',
        message: 'The user declined to answer the question',
        kind: 'rejected',
        note: 'Not now',
      },
      isError: true,
    });
  });

  it('with allowFreeText: false, an answer outside the options reaches the model as a tool error', async () => {
    const model = mockModel([asking({ question: 'Which city?', options: ['Porto'], allowFreeText: false }), 'Hm.']);
    const agent = createAgent({ provider: model, askQuestion: true });

    const paused = await agent.send('Book a trip');
    await agent.approvals.answer({ id: paused.approvalId!, answer: 'Faro' });

    expect(seen(model)).toMatchObject({ content: { kind: 'execution', message: 'The answer must be one of: Porto' }, isError: true });
  });

  it('an approve callback receives the question and may answer with a string', async () => {
    const model = mockModel([whichCity, 'Porto it is.']);
    const approve = vi.fn<Parameters<ApproveToolCall>, string>(() => 'Porto');
    const agent = createAgent({ provider: model, askQuestion: true, approve });

    const result = await agent.send('Book a trip');

    expect(result.text).toBe('Porto it is.');
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'question', question: { text: 'Which city?', options: ['Porto', 'Lisbon'] } })
    );
    expect(seen(model).content).toEqual({ answer: 'Porto', option: 0 });
  });

  it('approval.requested carries the question; inside a session the answer continues it', async () => {
    const model = mockModel([whichCity, 'Lisbon.', 'You picked Lisbon.']);
    const agent = createAgent({ provider: model, askQuestion: true });
    const session = agent.session({ id: 'trip' });
    const events: AgentEvent[] = [];

    for await (const event of session.stream('Book a trip')) events.push(event);
    const requested = events.find((event) => event.type === 'approval.requested');
    expect(requested).toMatchObject({ kind: 'question', question: { text: 'Which city?', options: ['Porto', 'Lisbon'] } });

    const answered = await agent.approvals.answer({ id: (requested as { approvalId: string }).approvalId, answer: 'Lisbon' });
    expect(answered.text).toBe('Lisbon.');
    expect((await session.send('Which city did I pick?')).text).toBe('You picked Lisbon.');
    expect(model.lastCall?.messages.some((m) => m.role === 'tool' && m.toolCallId === 'call_q')).toBe(true);
  });

  it('is only registered with askQuestion: true; run without an answer it fails', async () => {
    const model = mockModel(['Hi.']);
    await createAgent({ provider: model }).send('Hi');
    expect(model.lastCall?.tools?.map((tool) => tool.name) ?? []).not.toContain('ask_question');

    const ctx = { toolCallId: 'c1', messages: [] };
    await expect(askQuestionTool().execute({ question: 'Where?' }, ctx)).rejects.toThrow(/No answer/);
  });
});

const stores: Array<[string, () => AgentStore & { close?: () => void }]> = [
  ['memoryStore()', memoryStore],
  ["SqliteStore(':memory:')", () => new SqliteStore(':memory:')],
];

describe.each(stores)('ask_question with createAgent({ store: %s }) (LOU-X9)', (_name, makeStore) => {
  it('a restart between the question and the answer: a fresh agent answers and finishes the run', async () => {
    const store = makeStore();
    const before = createAgent({ provider: mockModel([whichCity]), askQuestion: true, store });
    const paused = await before.send('Book a trip', { sessionId: 'trip-1' });
    expect(paused.finishReason).toBe('awaiting-approval');

    const model = mockModel(['Booked Lisbon.']);
    const agent = createAgent({ provider: model, askQuestion: true, store });
    await expect(agent.resume('trip-1')).rejects.toMatchObject({ name: 'SessionAwaitingApprovalError' });
    const result = await agent.approvals.answer({ id: paused.approvalId!, answer: 'Lisbon' });

    expect(result.text).toBe('Booked Lisbon.');
    expect(seen(model).content).toEqual({ answer: 'Lisbon', option: 1 });
    expect(await store.checkpoints!.load('trip-1')).toMatchObject({ status: 'finished' });
    store.close?.();
  });
});
