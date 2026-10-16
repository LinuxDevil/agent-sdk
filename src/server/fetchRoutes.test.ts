/**
 * The session HTTP API as a client sees it: a heartbeat on a slow stream,
 * the statuses of a turn sent to a paused session and of a decision that lost
 * its race, and coded `400` bodies.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockTurn } from '../testing';
import { memoryStore } from '../storage/agentStore';
import { createRouteHandler, type RouteHandlerOptions } from './routeHandler';

const post = (path: string, body: unknown) =>
  new Request(`http://app.test/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

async function events(response: Response): Promise<Array<Record<string, unknown> & { type: string }>> {
  return (await response.text())
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)));
}

/** A promise and the function that settles it. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

function desk(script: readonly MockTurn[], options: RouteHandlerOptions = {}, refundGate?: Promise<void>) {
  const ledger: string[] = [];
  const refund = defineTool({
    name: 'issue_refund',
    description: 'Refunds an order',
    input: z.object({ orderId: z.string() }),
    needsApproval: true,
    execute: async ({ orderId }) => {
      await refundGate;
      ledger.push(orderId);
      return 'refunded';
    },
  });
  const agent = createAgent({ provider: mockModel(script), tools: [refund], store: memoryStore() });
  return { agent, ledger, ...createRouteHandler(agent, { basePath: '/api', ...options }) };
}

async function pausedRefund(handler: (request: Request) => Promise<Response>, sessionId: string): Promise<string> {
  const paused = await events(await handler(post('/chat', { sessionId, input: 'Refund B-1' })));
  const requested = paused.find((event) => event.type === 'approval.requested') as { approvalId: string } | undefined;
  expect(requested).toBeDefined();
  return requested!.approvalId;
}

const refundTurn: MockTurn[] = [{ toolCalls: [{ name: 'issue_refund', args: { orderId: 'B-1' } }] }, 'Refund issued.'];

/** Reads `response`'s body into `text` as it arrives. */
function collect(response: Response): { text: () => string; done: Promise<void> } {
  let text = '';
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const done = (async () => {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) text += decoder.decode(chunk.value);
  })();
  return { text: () => text, done };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SSE heartbeat', () => {
  it('writes a `: ping` comment while the model is slow, and stops once the stream ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const model = gate();
    const { handler } = desk([
      async () => {
        await model.wait;
        return 'Finally.';
      },
    ]);
    const body = collect(await handler(post('/chat', { sessionId: 'slow-1', input: 'hi' })));

    await vi.advanceTimersByTimeAsync(14_000);
    expect(body.text()).not.toContain(': ping');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(body.text().match(/: ping\n\n/g)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(body.text().match(/: ping\n\n/g)).toHaveLength(2);

    model.open();
    await body.done;
    expect(body.text()).toContain('"Finally."');
    expect(body.text().endsWith('event: done\ndata: {}\n\n')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('takes its interval from heartbeatMs, and 0 turns it off', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const model = gate();
    const slow: MockTurn = async () => {
      await model.wait;
      return 'Done.';
    };
    const fast = collect(await desk([slow], { heartbeatMs: 1_000 }).handler(post('/chat', { sessionId: 'fast-1', input: 'hi' })));
    const off = collect(await desk([slow], { heartbeatMs: 0 }).handler(post('/chat', { sessionId: 'off-1', input: 'hi' })));

    await vi.advanceTimersByTimeAsync(3_000);
    expect(fast.text().match(/: ping\n\n/g)).toHaveLength(3);
    expect(off.text()).not.toContain(': ping');

    model.open();
    await Promise.all([fast.done, off.done]);
  });

  it('stops when the client goes away', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const model = gate();
    const { handler } = desk([
      async () => {
        await model.wait;
        return 'Late.';
      },
    ]);
    const response = await handler(post('/chat', { sessionId: 'gone-1', input: 'hi' }));
    await response.body!.cancel();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(0);
    model.open();
  });
});

describe('a turn sent to a session paused on an approval', () => {
  it('is a 409 naming the approvals to decide, and runs nothing', async () => {
    const { handler, agent } = desk(refundTurn);
    const id = await pausedRefund(handler, 'paused-1');

    const response = await handler(post('/chat', { sessionId: 'paused-1', input: 'Anything else?' }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'LOUSHO_SESSION_AWAITING_APPROVAL', approvalId: id, approvalIds: [id] });
    expect((await agent.approvals.list()).map((approval) => approval.id)).toEqual([id]);
  });
});

describe('a decision that loses the race for an approval', () => {
  it('is a 409 while the winning continuation runs, and a 404 after', async () => {
    const tool = gate();
    const { handler, ledger, agent } = desk(refundTurn, {}, tool.wait);
    const id = await pausedRefund(handler, 'race-1');

    const winner = handler(post(`/chat/race-1/approvals/${id}`, { approved: true }));
    await vi.waitFor(async () => expect(await agent.approvals.list()).toEqual([]));

    // The approval is consumed and its tool is running: a retry or a second click now.
    const late = await handler(post(`/chat/race-1/approvals/${id}`, { approved: true }));
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ code: 'LOUSHO_APPROVAL_CONFLICT' });

    tool.open();
    const won = await winner;
    expect(won.status).toBe(200);
    const winning = collect(won);
    await winning.done;
    expect(winning.text()).toContain('Refund issued.');
    expect(ledger).toEqual(['B-1']);

    const after = await handler(post(`/chat/race-1/approvals/${id}`, { approved: true }));
    expect(after.status).toBe(404);
    expect(await after.json()).toMatchObject({ code: 'LOUSHO_APPROVAL_NOT_FOUND' });
  });
});

describe('400 bodies', () => {
  it('carry a code', async () => {
    const { handler } = desk(refundTurn);
    const id = await pausedRefund(handler, 'codes-1');

    const noDecision = await handler(post(`/chat/codes-1/approvals/${id}`, { approve: 'yes' }));
    expect(noDecision.status).toBe(400);
    expect(await noDecision.json()).toMatchObject({ code: 'LOUSHO_APPROVAL_DECISION_INVALID' });

    const badJson = await handler(post(`/chat/codes-1/approvals/${id}`, '{"approved":'));
    expect(badJson.status).toBe(400);
    expect(await badJson.json()).toMatchObject({ code: 'LOUSHO_REQUEST_INVALID' });

    const badId = await handler(post(`/chat/bad.id/approvals/${id}`, { approved: true }));
    expect(badId.status).toBe(400);
    expect(await badId.json()).toMatchObject({ code: 'LOUSHO_SESSION_ID_INVALID' });

    const empty = await handler(post('/chat', { sessionId: 'codes-2', input: [] }));
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ code: 'LOUSHO_REQUEST_INVALID' });
  });
});
