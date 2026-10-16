/**
 * `POST /chat` with an `Idempotency-Key`: a client that resends a turn
 * (a retry after a dropped connection, a double submit, a restart) gets that
 * turn's outcome instead of a second turn with the same side effects.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { PropagatingToolError } from '../execution/AgentExecutor';
import { mockModel, type MockTurn } from '../testing';
import { memoryStore, type AgentStore } from '../storage/agentStore';
import { createRouteHandler } from './routeHandler';

const post = (body: unknown, key?: string) =>
  new Request('http://app.test/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key !== undefined && { 'idempotency-key': key }) },
    body: JSON.stringify(body),
  });

async function events(response: Response): Promise<Array<Record<string, unknown> & { type: string }>> {
  return (await response.text())
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)));
}

const doneText = async (response: Response) => (await events(response)).find((event) => event.type === 'run.done')?.text;

function desk(script: readonly MockTurn[], store: AgentStore = memoryStore(), crashOnce = false) {
  const refunds: string[] = [];
  let runs = 0;
  const refund = defineTool({
    name: 'issue_refund',
    description: 'Refunds an order',
    input: z.object({ orderId: z.string() }),
    execute: async ({ orderId }) => {
      runs += 1;
      if (crashOnce && runs === 1) throw new PropagatingToolError('process died while refunding');
      refunds.push(orderId);
      return 'refunded';
    },
  });
  const model = mockModel(script);
  const agent = createAgent({ provider: model, tools: [refund], store });
  return { agent, model, refunds, store, ...createRouteHandler(agent, { basePath: '/api' }) };
}

const refundTurn: MockTurn[] = [{ toolCalls: [{ name: 'issue_refund', args: { orderId: 'B-1' } }] }, 'Refund issued.'];

const userMessages = async (store: AgentStore, id: string) => ((await store.sessions!.load(id)) ?? []).filter((message) => message.role === 'user');

describe('POST /chat with an Idempotency-Key', () => {
  it('replays a finished turn on a resend instead of running it again', async () => {
    const { handler, model, refunds, store } = desk(refundTurn);
    expect(await doneText(await handler(post({ sessionId: 'k-1', input: 'Refund B-1' }, 'req-1')))).toBe('Refund issued.');

    const resend = await handler(post({ sessionId: 'k-1', input: 'Refund B-1' }, 'req-1'));
    expect(resend.status).toBe(200);
    expect(resend.headers.get('content-type')).toBe('text/event-stream');
    expect(resend.headers.get('idempotent-replayed')).toBe('true');
    const replayed = await events(resend);
    expect(replayed.map((event) => event.type)).toEqual(['run.done']);
    expect(replayed[0]).toMatchObject({ text: 'Refund issued.', finishReason: 'stop' });

    expect(refunds).toEqual(['B-1']);
    expect(model.calls).toHaveLength(2);
    const users = await userMessages(store, 'k-1');
    expect(users).toHaveLength(1);
    expect(users[0].metadata).toMatchObject({ idempotencyKey: 'req-1' });
  });

  it('runs a new turn for a new key, and an unkeyed resend as before', async () => {
    const { handler, store } = desk(['One.', 'Two.', 'Three.']);
    expect(await doneText(await handler(post({ sessionId: 'k-2', input: 'hi' }, 'a')))).toBe('One.');
    expect(await doneText(await handler(post({ sessionId: 'k-2', input: 'hi' }, 'b')))).toBe('Two.');
    expect(await doneText(await handler(post({ sessionId: 'k-2', input: 'hi' })))).toBe('Three.');
    expect(await userMessages(store, 'k-2')).toHaveLength(3);
  });

  it('is a 409 while the same key is still running its turn', async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const { handler, model } = desk([
      async () => {
        await slow;
        return 'Done.';
      },
    ]);
    const first = await handler(post({ sessionId: 'k-3', input: 'hi' }, 'dup'));
    const firstEvents = events(first);

    const double = await handler(post({ sessionId: 'k-3', input: 'hi' }, 'dup'));
    expect(double.status).toBe(409);
    expect(await double.json()).toMatchObject({ code: 'LOUSHO_SESSION_BUSY' });

    release();
    expect((await firstEvents).find((event) => event.type === 'run.done')?.text).toBe('Done.');
    expect(model.calls).toHaveLength(1);
    // Once it finished, the same key replays.
    expect(await doneText(await handler(post({ sessionId: 'k-3', input: 'hi' }, 'dup')))).toBe('Done.');
  });

  it('survives a restart: a fresh agent over the same store replays the turn', async () => {
    const store = memoryStore();
    await events(await desk(['Stored.'], store).handler(post({ sessionId: 'k-4', input: 'hi' }, 'req-4')));

    const restarted = desk([], store);
    expect(await doneText(await restarted.handler(post({ sessionId: 'k-4', input: 'hi' }, 'req-4')))).toBe('Stored.');
    expect(restarted.model.calls).toHaveLength(0);
  });

  it('resumes a turn a crash interrupted, without appending the message again or re-running finished steps', async () => {
    const store = memoryStore();
    const crashed = desk(refundTurn, store, true);
    const failed = await events(await crashed.handler(post({ sessionId: 'k-5', input: 'Refund B-1' }, 'req-5')));
    expect(failed.some((event) => event.type === 'error')).toBe(true);
    expect(await crashed.agent.session({ id: 'k-5' }).pending()).toMatchObject({ status: 'in-progress', idempotencyKey: 'req-5' });

    const restarted = desk(['Refund issued.'], store);
    const resumed = await events(await restarted.handler(post({ sessionId: 'k-5', input: 'Refund B-1' }, 'req-5')));
    expect(resumed.find((event) => event.type === 'run.done')).toMatchObject({ text: 'Refund issued.', finishReason: 'stop' });
    expect(restarted.refunds).toEqual(['B-1']);
    expect(restarted.model.calls).toHaveLength(1);
    expect(await userMessages(store, 'k-5')).toHaveLength(1);
    expect(await restarted.agent.session({ id: 'k-5' }).pending()).toBeNull();
  });

  it('rejects a malformed key', async () => {
    const { handler } = desk(['x']);
    const response = await handler(post({ sessionId: 'k-6', input: 'hi' }, 'has space'));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'LOUSHO_REQUEST_INVALID' });
  });
});
