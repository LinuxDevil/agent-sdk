/**
 * Repro: authorization gaps of createRouteHandler for a multi-customer app.
 * In-process (handler(Request)), mockModel, no LLM.
 *
 *   npx tsx support-desk/repro/route-handler-authz.ts
 */
import { createAgent, createRouteHandler, defineTool, memoryStore } from '@lousho/build-ai-agent';
import type { AuthFn } from '@lousho/build-ai-agent/auth';
import { mockModel } from '@lousho/build-ai-agent/testing';
import { z } from 'zod';

const ledger: string[] = [];
const refund = defineTool({
  name: 'issue_refund',
  description: 'refund',
  input: z.object({ orderId: z.string(), amountUsd: z.number() }),
  needsApproval: ({ amountUsd }) => amountUsd > 50,
  execute: async ({ orderId, amountUsd }, ctx) => { ledger.push(`${orderId} $${amountUsd} for=${ctx.principal?.id} approvedBy=${ctx.approval?.by?.id}`); return 'refunded'; },
});
const auth: AuthFn = async (req) => {
  const t = req.headers.get('authorization');
  if (t === 'Bearer alice') return { id: 'alice', type: 'user', authenticator: 'custom' };
  if (t === 'Bearer bob') return { id: 'bob', type: 'user', authenticator: 'custom' };
  if (t === 'Bearer staff') return { id: 'staff', type: 'user', authenticator: 'custom', claims: { role: 'supervisor' } };
  return null;
};
const agent = createAgent({
  name: 'billing',
  store: memoryStore(),
  tools: [refund],
  provider: mockModel([
    'Hi Alice, your order A-1 ships Friday, tracking 1Z999.',
    { toolCalls: [{ name: 'issue_refund', args: { orderId: 'B-2001', amountUsd: 489 } }] },
    'Refund issued.',
    'Earlier we discussed order A-1, tracking 1Z999.',
  ]),
});
const { handler } = createRouteHandler(agent, { basePath: '/api', auth: [auth] });
const call = async (method: string, path: string, token: string, body?: unknown) => {
  const res = await handler(new Request(`http://x/api${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await res.text();
  const events = text.split('\n\n').filter((f) => f.startsWith('data: ')).map((f) => JSON.parse(f.slice(6)));
  return { status: res.status, text, events };
};

await call('POST', '/chat', 'alice', { sessionId: 'alice-1', input: 'Where is my order A-1?' });
const r = await call('POST', '/chat', 'bob', { sessionId: 'bob-1', input: 'Refund $489 on B-2001' });
const ev = r.events.find((e) => e.type === 'approval.requested');
console.log('1) approval.requested streamed to the CUSTOMER, with id:', ev?.approvalId, 'args:', JSON.stringify(ev?.args));
const self = await call('POST', `/chat/alice-1/approvals/${ev.approvalId}`, 'bob', { approved: true }); // note: wrong session id in the path, too
console.log('2) customer self-approves (path names ANOTHER session):', self.status, self.events.map((e) => e.type).join(','), '| ledger:', JSON.stringify(ledger));
const peek = await call('GET', '/chat/alice-1', 'bob');
console.log('3) bob GET /chat/alice-1:', peek.status, peek.text.slice(0, 160));
const hijack = await call('POST', '/chat', 'bob', { sessionId: 'alice-1', input: 'What did we discuss?' });
console.log('4) bob continues alice-1:', hijack.status, JSON.stringify(hijack.events.find((e) => e.type === 'run.done')?.text));
