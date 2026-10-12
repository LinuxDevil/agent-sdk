// Runtime checks for docs/nextjs.md: route table, statuses, approvals default.
import { z } from 'zod';
import { createAgent, createRouteHandler, defineTool, memoryStore } from '@lousho/build-ai-agent';
import { mockModel } from '@lousho/build-ai-agent/testing';

const log = (l: string, v: unknown) => console.log(`[${l}]`, typeof v === 'string' ? v : JSON.stringify(v));
const H = 'http://localhost';
const sse = async (res: Response) => {
  const t = await res.text();
  return { status: res.status, ct: res.headers.get('content-type'), lines: t.split('\n').filter(Boolean).map((l) => l.startsWith('data: ') ? (() => { try { const e = JSON.parse(l.slice(6)); return 'data:' + (e.type ?? Object.keys(e).join(',')) + (e.approvalId ? `(${e.approvalId})` : ''); } catch { return l.slice(0, 60); } })() : l.slice(0, 60)) };
};

const del = defineTool({ name: 'delete_reports', description: 'Deletes reports', input: z.object({}), needsApproval: true, execute: async () => 'deleted' } as any);
const model = mockModel([{ toolCalls: [{ name: 'delete_reports' }] }, 'Deleted.', 'hello again', 'x', 'y', 'z'], { onExhausted: 'repeat-last' });
const agent = createAgent({ provider: model, tools: [del], store: memoryStore() });

// auth function: user from header
const { GET, POST } = createRouteHandler(agent, {
  basePath: '/api/agent',
  auth: (async (req: Request) => {
    const u = req.headers.get('x-user');
    return u ? { id: u, type: 'user', authenticator: 'test' } : null;
  }) as any,
});
const as = (user: string | undefined, method: string, path: string, body?: unknown) =>
  (method === 'GET' ? GET : POST)(new Request(H + path, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-user': user } : {}) }, ...(body !== undefined && { body: JSON.stringify(body) }) }));

log('health no auth', (await as(undefined, 'GET', '/api/agent/health')).status);
log('outside base', (await as('alice', 'GET', '/other/health')).status);
log('trailing slash health', (await as(undefined, 'GET', '/api/agent/health/')).status);
const unauth = await as(undefined, 'POST', '/api/agent', { input: 'hi' });
log('no creds', { status: unauth.status, body: (await unauth.text()).slice(0, 120) });

// alice starts a run that pauses
const r1 = await sse(await as('alice', 'POST', '/api/agent', { input: 'Delete the old reports', sessionId: 's-alice' }));
log('POST base', r1);
const approvalId = /approval\.requested\((.+?)\)/.exec(r1.lines.join(' '))?.[1];
log('approvalId', approvalId);

// GET transcript
const g = await as('alice', 'GET', '/api/agent/chat/s-alice');
const gj: any = await g.json().catch(() => ({}));
log('GET /chat/:id', { status: g.status, keys: Object.keys(gj), msgs: gj.messages?.length, pending: gj.pendingApprovals?.length ?? gj.approvals?.length });

// bob reads alice's session (no authorizeSession) -> per F3 already reported; just confirm
log('bob reads alice session', (await as('bob', 'GET', '/api/agent/chat/s-alice')).status);

// alice approves her own call - docs/nextjs.md:70-72 says she cannot by default
const ap = await as('alice', 'POST', `/api/agent/approvals/${approvalId}`, { approved: true });
const aps = await sse(ap);
log('alice self-approves', aps);

// bob decides a new pending approval of alice
const r2 = await sse(await as('alice', 'POST', '/api/agent', { input: 'Delete again', sessionId: 's-alice2' }));
const id2 = /approval\.requested\((.+?)\)/.exec(r2.lines.join(' '))?.[1];
const bobAp = await as('bob', 'POST', `/api/agent/approvals/${id2}`, { approved: true });
log('bob approves alice call', { id2, status: bobAp.status, body: (await bobAp.text()).slice(0, 200) });

// unknown approval id
const unk = await as('alice', 'POST', '/api/agent/approvals/nope', { approved: true });
log('unknown approval', { status: unk.status, body: (await unk.text()).slice(0, 200) });

// approvers option is ignored (not in types) - does TS/runtime complain?
try { createRouteHandler(agent, { approvers: (c: unknown) => c !== undefined } as any); log('approvers option', 'accepted silently at runtime'); } catch (e: any) { log('approvers option', e.message); }

// POST without sessionId -> fresh session each turn
const n1 = await sse(await as('alice', 'POST', '/api/agent', { input: 'no session' }));
log('POST no sessionId', n1.lines.slice(-3));

// /ui without uiMessageStream
log('/ui without option', (await as('alice', 'POST', '/api/agent/ui', { messages: [] })).status);
// empty body / bad input
const bad = await as('alice', 'POST', '/api/agent/chat', { sessionId: 'x' });
log('POST /chat missing input', { status: bad.status, body: (await bad.text()).slice(0, 160) });
