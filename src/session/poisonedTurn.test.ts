/**
 * Eve DUR-F11: a checkpointed turn that fails with a provider error that
 * retrying cannot fix (a 400, e.g. the context window overflowed) no longer
 * bricks the session by being replayed on every later send(): the checkpoint
 * records the error and the attempts, and send() fails fast with
 * LOUSHO_SESSION_TURN_FAILED until discardPending() drops the turn.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { memoryStore } from '../storage/agentStore';
import { mockModel, type MockRequest, type MockStaticTurn } from '../testing';

const dumpLogs = defineTool({ name: 'dump_logs', description: 'dump logs', input: z.object({}), execute: async () => 'HUGE'.repeat(10) });

/** A model whose call after the `dump_logs` result fails with `error`; other turns answer. */
function poisoning(error: Error) {
  const turn = (request: MockRequest): MockStaticTurn => {
    if (request.messages.some((m) => m.role === 'tool' && String(m.content).includes('HUGE'))) return { error };
    const lastUser = [...request.messages].reverse().find((m) => m.role === 'user');
    if (String(lastUser?.content).startsWith('A')) return { toolCalls: [{ name: 'dump_logs', args: {} }] };
    return `ok: ${String(lastUser?.content)}`;
  };
  return mockModel([turn], { onExhausted: 'repeat-last' });
}

const overflow = () => Object.assign(new Error('400 context_length_exceeded: maximum context length is 128000 tokens'), { status: 400 });

describe('a checkpointed turn that failed for good (Eve DUR-F11)', () => {
  it('records the error on the checkpoint and fails later sends fast, naming discardPending()', async () => {
    const store = memoryStore();
    const model = poisoning(overflow());
    const session = createAgent({ provider: model, tools: [dumpLogs], store }).session({ id: 'chat' });

    await expect(session.send('A: show me the logs')).rejects.toThrow('context_length_exceeded');
    const checkpoint = await store.checkpoints.load('chat.turn-0');
    expect(checkpoint).toMatchObject({ status: 'in-progress', attempts: 1, lastError: { retryable: false } });
    expect(checkpoint?.lastError?.message).toContain('context_length_exceeded');
    const calls = model.calls.length;

    const failed = session.send('B: never mind, say hi');
    await expect(failed).rejects.toMatchObject({ code: 'LOUSHO_SESSION_TURN_FAILED' });
    await expect(failed).rejects.toThrow('discardPending()');
    expect(model.calls).toHaveLength(calls); // the poisoned turn was not replayed
    expect(await session.pending()).toMatchObject({ status: 'in-progress' });

    // An explicit resume() still retries it, and counts the attempt.
    await expect(session.resume()).rejects.toThrow('context_length_exceeded');
    expect(await store.checkpoints.load('chat.turn-0')).toMatchObject({ attempts: 2 });

    await session.discardPending();
    expect((await session.send('C: hello?')).text).toBe('ok: C: hello?');
  });

  it('a retryable failure is still resumed by the next send()', async () => {
    const store = memoryStore();
    const unavailable = Object.assign(new Error('503 service unavailable'), { status: 503 });
    const failing = createAgent({ provider: poisoning(unavailable), tools: [dumpLogs], store, retry: false }).session({ id: 'chat' });
    await expect(failing.send('A: show me the logs')).rejects.toThrow();
    expect(await store.checkpoints.load('chat.turn-0')).toMatchObject({ attempts: 1, lastError: { retryable: true } });

    const model = mockModel(['Logs summarized.', 'Hi.']);
    const result = await createAgent({ provider: model, tools: [dumpLogs], store }).session({ id: 'chat' }).send('B: say hi');
    expect(result.text).toBe('Hi.');
    expect(model.calls).toHaveLength(2);
  });

  it('a crash (not a provider error) stays resumable as before', async () => {
    const store = memoryStore();
    const crash = new Error('process died');
    const session = createAgent({ provider: poisoning(crash), tools: [dumpLogs], store }).session({ id: 'chat' });
    await expect(session.send('A: show me the logs')).rejects.toThrow('process died');
    const model = mockModel(['Done.', 'Hi.']);
    expect((await createAgent({ provider: model, tools: [dumpLogs], store }).session({ id: 'chat' }).send('B')).text).toBe('Hi.');
  });
});
