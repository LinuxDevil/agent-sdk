/**
 * A1 (audit support-desk F5, F6, F10, F11): who may use a session and decide
 * an approval over the session routes, consistent statuses for racing
 * decisions, and no provider error text on the wire.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel } from '../testing';
import { memoryStore, type AgentStore } from '../storage/agentStore';
import { createRouteHandler, type RouteHandlerOptions } from './routeHandler';
import { serveFetch } from './fetchRoutes';
import type { AuthFn, Principal } from '../auth';

const user = (id: string, claims?: Record<string, unknown>): Principal => ({ id, type: 'user', authenticator: 'custom', ...(claims && { claims }) });

/** `Bearer <name>` is that user; `staff` is a supervisor. */
const auth: AuthFn = async (request) => {
  const name = request.headers.get('authorization')?.replace(/^Bearer /, '');
  if (!name) return null;
  return name === 'staff' ? user('staff', { role: 'supervisor' }) : user(name);
};

function refundDesk(replies: Parameters<typeof mockModel>[0], options: Omit<RouteHandlerOptions, 'auth'> = {}, store: AgentStore = memoryStore()) {
  const ledger: string[] = [];
  const refund = defineTool({
    name: 'issue_refund',
    description: 'Refunds an order',
    input: z.object({ orderId: z.string() }),
    needsApproval: true,
    execute: async ({ orderId }, ctx) => {
      ledger.push(`${orderId} for=${ctx.principal?.id} by=${ctx.approval?.by?.id}`);
      return 'refunded';
    },
  });
  const model = mockModel(replies);
  const agent = createAgent({ provider: model, tools: [refund], store });
  return { agent, ledger, model, ...createRouteHandler(agent, { basePath: '/api', auth: [auth], ...options }) };
}

const call = (method: string, path: string, as: string, body?: unknown) =>
  new Request(`http://app.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${as}`, 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

async function events(response: Response): Promise<Array<Record<string, unknown> & { type: string }>> {
  return (await response.text())
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)));
}

/** Starts a turn as `as` in `sessionId` that pauses on a refund; resolves the approval id. */
async function pausedRefund(handler: (request: Request) => Promise<Response>, as: string, sessionId: string): Promise<string> {
  const paused = await events(await handler(call('POST', '/chat', as, { sessionId, input: 'Refund B-1' })));
  const requested = paused.find((event) => event.type === 'approval.requested') as { approvalId: string } | undefined;
  expect(requested).toBeDefined();
  return requested!.approvalId;
}

const refundTurn = [{ toolCalls: [{ name: 'issue_refund', args: { orderId: 'B-1' } }] }, 'Refund issued.'];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('approvals belong to their session (A1, F5)', () => {
  it('a decision posted under another session is a 404 and runs nothing; under its own session it runs', async () => {
    const { handler, ledger } = refundDesk(['Hi.', ...refundTurn]);
    await events(await handler(call('POST', '/chat', 'bob', { sessionId: 'bob-other', input: 'hi' })));
    const id = await pausedRefund(handler, 'bob', 'bob-1');

    const wrong = await handler(call('POST', `/chat/bob-other/approvals/${id}`, 'bob', { approved: true }));
    expect(wrong.status).toBe(404);
    expect(await wrong.json()).toMatchObject({ code: 'LOUSHO_APPROVAL_NOT_FOUND' });
    expect(ledger).toEqual([]);

    const right = await events(await handler(call('POST', `/chat/bob-1/approvals/${id}`, 'bob', { approved: true })));
    expect(right.at(-1)).toMatchObject({ type: 'run.done', finishReason: 'stop' });
    expect(ledger).toEqual(['B-1 for=bob by=bob']);
  });

  it('checks a pause made by another process against the session in the URL and its saved principal', async () => {
    const store = memoryStore();
    const first = refundDesk(refundTurn, {}, store);
    const id = await pausedRefund(first.handler, 'alice', 'alice-1');

    // A new process on the same store: the pause is only known through the store and the session's checkpoint.
    const second = refundDesk(['Refund issued.'], {}, store);
    expect((await second.handler(call('POST', `/chat/alice-2/approvals/${id}`, 'alice', { approved: true }))).status).toBe(404);
    expect((await second.handler(call('POST', `/chat/alice-1/approvals/${id}`, 'bob', { approved: true }))).status).toBe(403);
    expect(second.ledger).toEqual([]);

    const continued = await events(await second.handler(call('POST', `/chat/alice-1/approvals/${id}`, 'alice', { approved: true })));
    expect(continued.at(-1)).toMatchObject({ type: 'run.done', finishReason: 'stop' });
    expect(second.ledger).toEqual(['B-1 for=alice by=alice']);
  });
});

describe('authorizeApproval (A1, F5)', () => {
  it("by default, a caller cannot decide another caller's approval, but can confirm their own", async () => {
    const { handler, ledger } = refundDesk(refundTurn);
    const id = await pausedRefund(handler, 'alice', 'alice-1');

    const bob = await handler(call('POST', `/chat/alice-1/approvals/${id}`, 'bob', { approved: true }));
    expect(bob.status).toBe(403);
    expect(await bob.json()).toMatchObject({ code: 'LOUSHO_APPROVAL_FORBIDDEN' });
    expect(ledger).toEqual([]);

    await events(await handler(call('POST', `/chat/alice-1/approvals/${id}`, 'alice', { approved: true })));
    expect(ledger).toEqual(['B-1 for=alice by=alice']);
  });

  it('a supervisor-only gate stops a customer approving their own refund (the reported attack)', async () => {
    const { handler, ledger } = refundDesk(refundTurn, {
      authorizeApproval: ({ principal }) => principal?.claims?.role === 'supervisor',
    });
    const id = await pausedRefund(handler, 'bob', 'bob-1');

    for (const body of [{ approved: true }, { answer: 'yes' }]) {
      const self = await handler(call('POST', `/chat/bob-1/approvals/${id}`, 'bob', body));
      expect(self.status).toBe(403);
    }
    expect(ledger).toEqual([]);

    const staff = await events(await handler(call('POST', `/chat/bob-1/approvals/${id}`, 'staff', { approved: true })));
    expect(staff.at(-1)).toMatchObject({ type: 'run.done', finishReason: 'stop' });
    expect(ledger).toEqual(['B-1 for=bob by=staff']);
  });

  it('gets the approval, the session and the caller', async () => {
    const seen = vi.fn(() => true);
    const { handler } = refundDesk(refundTurn, { authorizeApproval: seen });
    const id = await pausedRefund(handler, 'alice', 'alice-1');
    await events(await handler(call('POST', `/chat/alice-1/approvals/${id}`, 'alice', { approved: false })));
    expect(seen).toHaveBeenCalledWith({
      principal: user('alice'),
      sessionId: 'alice-1',
      approval: expect.objectContaining({ id, toolName: 'issue_refund', sessionId: 'alice-1', principal: user('alice') }),
    });
  });
});

describe('authorizeSession (A1, F6)', () => {
  const ownSessions: RouteHandlerOptions['authorizeSession'] = ({ principal, sessionId, action }) =>
    sessionId.startsWith(`${principal?.id}-`) || (action === 'approve' && principal?.claims?.role === 'supervisor');

  it("refuses reading, continuing and deciding approvals of another caller's session", async () => {
    const { handler, model, ledger } = refundDesk(['Your order A-1 ships Friday.', ...refundTurn], {
      authorizeSession: ownSessions,
      authorizeApproval: () => true,
    });
    await events(await handler(call('POST', '/chat', 'alice', { sessionId: 'alice-1', input: 'Where is A-1?' })));
    const calls = model.calls.length;

    const read = await handler(call('GET', '/chat/alice-1', 'bob'));
    expect(read.status).toBe(403);
    const body = await read.json();
    expect(body).toMatchObject({ code: 'LOUSHO_SESSION_FORBIDDEN' });
    expect(JSON.stringify(body)).not.toContain('A-1');

    const hijack = await handler(call('POST', '/chat', 'bob', { sessionId: 'alice-1', input: 'What did we discuss?' }));
    expect(hijack.status).toBe(403);
    expect(model.calls.length).toBe(calls);

    const id = await pausedRefund(handler, 'alice', 'alice-1');
    expect((await handler(call('POST', `/chat/alice-1/approvals/${id}`, 'bob', { approved: true }))).status).toBe(403);
    expect(ledger).toEqual([]);

    // The owner, and a supervisor deciding, still get through.
    expect((await handler(call('GET', '/chat/alice-1', 'alice'))).status).toBe(200);
    await events(await handler(call('POST', `/chat/alice-1/approvals/${id}`, 'staff', { approved: true })));
    expect(ledger).toEqual(['B-1 for=alice by=staff']);
  });

  it('covers the useChat endpoint and the useLoushoAgent approvals route too', async () => {
    const { handler, ledger } = refundDesk(refundTurn, { authorizeSession: ownSessions, uiMessageStream: true });
    const ui = await handler(call('POST', '/ui', 'bob', { id: 'alice-1', messages: [{ id: 'm', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }));
    expect(ui.status).toBe(403);

    const id = await pausedRefund(handler, 'alice', 'alice-1');
    // `POST <base>/approvals/:id` names no session: the approval's own session is checked.
    expect((await handler(call('POST', `/approvals/${id}`, 'bob', { approved: true }))).status).toBe(403);
    expect(ledger).toEqual([]);
    expect((await handler(call('POST', `/approvals/${id}`, 'alice', { approved: true }))).status).toBe(200);
  });
});

describe('concurrent decisions (A1, F10)', () => {
  it('the request that loses the race for an approval gets a 409, a later one a 404', async () => {
    const { handler, ledger } = refundDesk(refundTurn);
    const id = await pausedRefund(handler, 'alice', 'alice-1');

    const responses = await Promise.all([1, 2].map(() => handler(call('POST', `/chat/alice-1/approvals/${id}`, 'alice', { approved: true }))));
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 409]);
    const loser = responses.find((response) => response.status === 409)!;
    expect(await loser.json()).toMatchObject({ code: 'LOUSHO_APPROVAL_CONFLICT' });
    await Promise.all(responses.filter((response) => response.status === 200).map((response) => response.text()));
    expect(ledger).toHaveLength(1);

    expect((await handler(call('POST', `/chat/alice-1/approvals/${id}`, 'alice', { approved: true }))).status).toBe(404);
  });
});

describe('error redaction (A1, F11)', () => {
  const TEMPLATE_LEAK = "Jinja Exception: {{ raise_exception('System message must be at the beginning.') }}";
  const failing = () => Object.assign(new Error(`Upstream 500: ${TEMPLATE_LEAK}`), { code: 'LOUSHO_PROVIDER_REQUEST_FAILED' });

  it('streams the error name and code with a generic message, and logs the details', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = refundDesk([{ error: failing() }]);
    const response = await handler(call('POST', '/chat', 'alice', { sessionId: 'alice-1', input: 'hi' }));
    const text = await response.text();
    expect(text).not.toContain('raise_exception');
    expect(text).not.toContain('Upstream 500');
    const error = text
      .split('\n\n')
      .filter((frame) => frame.startsWith('data: '))
      .map((frame) => JSON.parse(frame.slice(6)))
      .find((event) => event.type === 'error');
    expect(error.error).toMatchObject({ code: 'LOUSHO_PROVIDER_REQUEST_FAILED', message: expect.stringContaining('server log') });
    expect(JSON.stringify(log.mock.calls)).toContain('raise_exception');
  });

  it('keeps a failed request\'s 500 and the useChat stream generic too', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = refundDesk([{ error: failing() }], {
      uiMessageStream: true,
      authorizeSession: ({ action }) => {
        if (action === 'read') throw new Error('db password=hunter2 refused');
        return true;
      },
    });
    const failed = await handler(call('GET', '/chat/alice-1', 'alice'));
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain('hunter2');

    const ui = await handler(call('POST', '/ui', 'alice', { id: 'alice-1', messages: [{ id: 'm', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }));
    expect(await ui.text()).not.toContain('raise_exception');
  });

  it('streams the raw message with exposeErrors (lousho dev), and on the deployed server only when asked', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exposed = refundDesk([{ error: failing() }], { exposeErrors: true });
    expect(await (await exposed.handler(call('POST', '/chat', 'alice', { sessionId: 's', input: 'hi' }))).text()).toContain('raise_exception');

    const agent = createAgent({ provider: mockModel([{ error: failing() }]), store: memoryStore() });
    const request = () => new Request('http://x/chat', { method: 'POST', body: JSON.stringify({ sessionId: 's', input: 'hi' }) });
    expect(await (await serveFetch(request(), { name: 'server', agent: () => agent })).text()).not.toContain('raise_exception');
  });
});

describe('an empty auth token (Eve CH-F16)', () => {
  it('serveFetch fails closed instead of serving the routes open', async () => {
    const agent = createAgent({ provider: mockModel(['hi']), store: memoryStore() });
    const request = new Request('http://x/chat', { method: 'POST', body: JSON.stringify({ sessionId: 's', input: 'hi' }) });
    await expect(serveFetch(request, { name: 'server', agent: () => agent }, '')).rejects.toMatchObject({ code: 'LOUSHO_AUTH_CONFIG_INVALID' });
  });
});
