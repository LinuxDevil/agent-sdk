import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import { memoryStore } from '../storage/agentStore';
import { createRouteHandler, type RouteHandlerOptions } from './routeHandler';
import type { Message } from '../providers/llm';

/**
 * B4 (support-desk F7): a client that goes away while a side-effecting tool
 * runs. The refund happens once, and the session keeps the turn that made it.
 */

const post = (path: string, body: unknown, signal?: AbortSignal) =>
  new Request(`http://app.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });

function refundDesk(replies: Parameters<typeof mockModel>[0], options: RouteHandlerOptions = {}, needsApproval = false) {
  const ledger: Array<{ amountUsd: number; aborted: boolean }> = [];
  const refund = defineTool({
    name: 'issue_refund',
    description: 'Refunds an order',
    input: z.object({ amountUsd: z.number() }),
    needsApproval,
    execute: async ({ amountUsd }, ctx) => {
      await new Promise((resolve) => setTimeout(resolve, 40)); // the payment API
      ledger.push({ amountUsd, aborted: ctx.abortSignal?.aborted ?? false });
      return { refunded: amountUsd };
    },
  });
  const model = mockModel(replies);
  const agent = createAgent({ provider: model, tools: [refund], store: memoryStore() });
  const waited: Array<Promise<unknown>> = [];
  const routes = createRouteHandler(agent, { waitUntil: (promise) => void waited.push(promise), ...options });
  return { agent, model, ledger, waited, routes };
}

/** Reads SSE frames until `stopAt`, then drops the connection the way a closed browser tab does. */
async function readUntil(response: Response, stopAt: string, controller: AbortController): Promise<string[]> {
  const reader = response.body!.getReader();
  const seen: string[] = [];
  const decoder = new TextDecoder();
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    for (const type of decoder.decode(chunk.value).matchAll(/"type":"([^"]+)"/g)) seen.push(type[1]);
    if (seen.includes(stopAt)) {
      controller.abort();
      await reader.cancel();
      break;
    }
  }
  return seen;
}

const shape = (messages: readonly Message[]) =>
  messages.map((m) => (m.role === 'tool' ? `tool:${String(m.content)}` : m.toolCalls?.length ? `${m.role}:calls` : `${m.role}:${String(m.content)}`));

describe('a client disconnect mid-turn (B4)', () => {
  it('lets the turn finish and persists it, with the side effect run once', async () => {
    const { agent, model, ledger, waited, routes } = refundDesk([
      { toolCalls: [{ name: 'issue_refund', args: { amountUsd: 20 } }] },
      'Refunded $20.',
      'Yes, the $20 refund went through.',
    ]);
    const controller = new AbortController();
    const response = await routes.handler(post('/api/agent/chat', { sessionId: 'cust-1', input: 'refund $20 please' }, controller.signal));
    const seen = await readUntil(response, 'tool.start', controller);
    expect(seen).toContain('tool.start');
    expect(waited).toHaveLength(1);
    await Promise.all(waited);

    expect(ledger).toEqual([{ amountUsd: 20, aborted: false }]);
    const session = agent.session({ id: 'cust-1' });
    expect(shape((await session.load()) ?? [])).toEqual(['user:refund $20 please', 'assistant:calls', 'tool:{"refunded":20}', 'assistant:Refunded $20.']);
    expect(await session.pending()).toBeNull();

    // The retry turn sees the refund; nothing is refunded again.
    const retry = await session.send('my connection dropped - did it go through?');
    expect(retry.text).toBe('Yes, the $20 refund went through.');
    expect(model.calls[2].messages.some((m) => m.role === 'tool')).toBe(true);
    expect(ledger).toHaveLength(1);
  });

  it('keeps a decided approval running when the client leaves the continuation stream', async () => {
    const { agent, ledger, waited, routes } = refundDesk(
      [{ toolCalls: [{ name: 'issue_refund', id: 'r1', args: { amountUsd: 20 } }] }, 'Refunded $20.'],
      {},
      true
    );
    const paused = await (await routes.handler(post('/api/agent/chat', { sessionId: 'cust-2', input: 'refund' }))).text();
    const approvalId = /"approvalId":"([^"]+)"/.exec(paused)?.[1];
    expect(approvalId).toBeTruthy();

    const controller = new AbortController();
    const response = await routes.handler(post(`/api/agent/chat/cust-2/approvals/${approvalId}`, { approved: true }, controller.signal));
    await readUntil(response, 'tool.start', controller);
    await Promise.all(waited);

    expect(ledger).toEqual([{ amountUsd: 20, aborted: false }]);
    expect(shape((await agent.session({ id: 'cust-2' }).load()) ?? []).slice(-2)).toEqual(['tool:{"refunded":20}', 'assistant:Refunded $20.']);
  });

  it('keeps a useChat turn running when the client goes away', async () => {
    const { agent, ledger, waited, routes } = refundDesk(
      [{ toolCalls: [{ name: 'issue_refund', args: { amountUsd: 5 } }] }, 'Refunded $5.'],
      { uiMessageStream: true }
    );
    const controller = new AbortController();
    const body = { id: 'cust-3', messages: [{ role: 'user', parts: [{ type: 'text', text: 'refund $5' }] }] };
    const response = await routes.handler(post('/api/agent/ui', body, controller.signal));
    await readUntil(response, 'tool-input-available', controller);
    await vi.waitFor(() => expect(waited).toHaveLength(1));
    await Promise.all(waited);

    expect(ledger).toEqual([{ amountUsd: 5, aborted: false }]);
    expect(shape((await agent.session({ id: 'cust-3' }).load()) ?? [])).toEqual(['user:refund $5', 'assistant:calls', 'tool:{"refunded":5}', 'assistant:Refunded $5.']);
  });

  it("onDisconnect: 'abort' aborts the turn, and keeps the result of a tool call that already ran", async () => {
    const { agent, ledger, waited, routes } = refundDesk(
      [{ toolCalls: [{ name: 'issue_refund', args: { amountUsd: 20 } }] }, { text: 'never sent', delayMs: 200 }],
      { onDisconnect: 'abort' }
    );
    const controller = new AbortController();
    const response = await routes.handler(post('/api/agent/chat', { sessionId: 'cust-4', input: 'refund $20 please' }, controller.signal));
    await readUntil(response, 'tool.done', controller);
    expect(waited).toHaveLength(0);

    const transcript = async () => shape((await agent.session({ id: 'cust-4' }).load()) ?? []);
    await vi.waitFor(async () => expect(await transcript()).toEqual(['user:refund $20 please', 'assistant:calls', 'tool:{"refunded":20}']));
    expect(ledger).toEqual([{ amountUsd: 20, aborted: false }]);
    expect(await agent.session({ id: 'cust-4' }).pending()).toBeNull();
  });
});
