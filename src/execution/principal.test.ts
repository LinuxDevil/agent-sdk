/**
 * N10b: the run's principal reaches tools, `needsApproval` policies,
 * permission rules, hooks and in-process sub-agents; it is kept across an
 * approval pause and a crash; the caller who decides an approval is recorded
 * as the approver (`ctx.approval.by`), never swapped in as the run's principal.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type * as http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockTurn } from '../testing';
import { memoryStore } from '../storage/agentStore';
import { SqliteStore } from '../storage/sqlite';
import { apiToken, type Principal } from '../auth';
import { createRouteHandler } from '../server/routeHandler';
import { serveFetch } from '../server/fetchRoutes';
import { defineChannel } from '../channels/defineChannel';
import { mountChannels, type ChannelsHandler } from '../channels/mountChannels';
import { remoteAgent } from '../subagents/remoteAgent';
import { PropagatingToolError } from './propagatingToolError';
import { InMemoryApprovalStore } from './InMemoryApprovalStore';
import type { ApprovalStore, ExecutionSnapshot, PendingApproval } from './ApprovalGate';
import type { PermissionAuditContext, PermissionDecisionEntry } from './permissions';
import type { ToolExecutionContext } from '../types';
import type { AgentEvent } from './agentEvents';
import type { Span, TraceExporter } from './tracing';
import type { RunConfigContext } from '../createAgent';

const ALICE: Principal = { id: 'alice', type: 'user', authenticator: 'jwt', issuer: 'https://id.test', claims: { email: 'alice@example.com', roles: ['dev'] } };
const BOB: Principal = { id: 'bob', type: 'user', authenticator: 'jwt', issuer: 'https://id.test' };

/** A tool recording the context of each call; `needsApproval` and `crashOnce` as given. */
function probe(name: string, options: { needsApproval?: boolean; crashOnce?: boolean; mutate?: boolean } = {}) {
  const seen: ToolExecutionContext[] = [];
  const tool = defineTool({
    name,
    description: `Probe ${name}`,
    input: z.object({}),
    ...(options.needsApproval && { needsApproval: true }),
    execute: (_args, ctx) => {
      seen.push(ctx);
      if (options.crashOnce && seen.length === 1) throw new PropagatingToolError(`process died while running ${name}`);
      if (options.mutate && ctx.principal) (ctx.principal as { id: string }).id = 'mallory';
      return `${name} done`;
    },
  });
  return { tool, seen, ids: () => seen.map((ctx) => ctx.principal?.id) };
}

const calling = (...names: string[]): MockTurn => ({ toolCalls: names.map((name) => ({ name, id: `call_${name}` })) });
const task = (agent: string, extra: Record<string, unknown> = {}): MockTurn => ({ toolCalls: [{ name: 'task', id: `task_${agent}`, args: { agent, prompt: 'do it', description: `${agent} task`, ...extra } }] });

async function collect(run: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the principal in tools, policies and permission rules (N10b)', () => {
  it('a tool reads ctx.principal from send(), stream() and a session turn', async () => {
    const whoami = probe('whoami');
    const agent = createAgent({ provider: mockModel([calling('whoami'), 'a', calling('whoami'), 'b', calling('whoami'), 'c']), tools: [whoami.tool] });

    await agent.send('who?', { principal: ALICE });
    await collect(agent.stream('who?', { principal: BOB }));
    await agent.session({ id: 's1' }).send('who?', { principal: ALICE });

    expect(whoami.ids()).toEqual(['alice', 'bob', 'alice']);
    expect(whoami.seen[0].principal).toEqual(ALICE);
  });

  it('a run without a principal gives tools none (and an old caller sees no change)', async () => {
    const whoami = probe('whoami');
    const agent = createAgent({ provider: mockModel([calling('whoami'), 'ok']), tools: [whoami.tool] });
    await agent.send('who?');
    expect(whoami.seen[0]).not.toHaveProperty('principal');
  });

  it("a channel turn's tool sees the channel's verified sender", async () => {
    const whoami = probe('whoami');
    const agent = createAgent({ provider: mockModel([calling('whoami'), 'hi']), tools: [whoami.tool] });
    const channel = defineChannel({
      name: 'test',
      async parse(req) {
        const { user, text } = JSON.parse(req.text) as { user: string; text: string };
        return { sessionKey: user, input: text, replyTo: user, principal: { id: user, type: 'user', authenticator: 'test' } };
      },
      async reply() {},
    });
    await post(mountChannels(agent, [channel]), '/channels/test', { user: 'U42', text: 'hi' });
    expect(whoami.seen[0].principal).toEqual({ id: 'U42', type: 'user', authenticator: 'test' });
  });

  it('needsApproval, permission rules, tool-call hooks and the audit callback receive it; events and the audit entry do not', async () => {
    const checks: Array<string | undefined> = [];
    const deploy = defineTool({
      name: 'deploy',
      description: 'Deploys',
      input: z.object({}),
      // Ask only callers without an `admin` claim.
      needsApproval: (_args, ctx) => (checks.push(`policy:${ctx.principal?.id}`), ctx.principal?.claims?.admin !== true),
      execute: () => 'deployed',
    });
    const audit: Array<[PermissionDecisionEntry, PermissionAuditContext]> = [];
    const agent = createAgent({
      provider: mockModel([calling('deploy'), 'done', calling('deploy')]),
      tools: [deploy],
      permissions: [{ tool: 'deploy', when: (_args, ctx) => (checks.push(`rule:${ctx.principal?.id}`), ctx.principal?.type === 'service'), action: 'deny' }],
      hooks: [{ name: 'audit', preToolCall: (ctx) => void checks.push(`hook:${ctx.principal?.id}`) }],
      onPermissionDecision: (entry, ctx) => audit.push([entry, ctx]),
    });

    const admin: Principal = { ...ALICE, claims: { admin: true } };
    const events = await collect(agent.stream('deploy', { principal: admin }));
    const paused = await agent.send('deploy', { principal: BOB });

    expect(events.at(-1)).toMatchObject({ type: 'run.done', finishReason: 'stop' });
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(checks).toEqual(['hook:alice', 'rule:alice', 'policy:alice', 'hook:bob', 'rule:bob', 'policy:bob']);
    expect(audit.map(([, ctx]) => ctx.principal?.id)).toEqual(['alice', 'bob']);
    expect(audit.every(([entry]) => !('principal' in entry))).toBe(true);
    // No caller identity in the event stream: not on permission.decision, not anywhere.
    expect(JSON.stringify(events)).not.toContain('alice');
  });

  it('ctx.principal and ctx.approval.by are frozen: a tool that changes them throws (strict mode)', async () => {
    const mutating = probe('mutating', { mutate: true });
    const agent = createAgent({ provider: mockModel([calling('mutating'), 'done']), tools: [mutating.tool] });
    const result = await agent.send('go', { principal: ALICE });

    const toolMessage = result.messages.find((m) => m.role === 'tool');
    expect(toolMessage?.isError).toBe(true);
    expect(String(toolMessage?.content)).toMatch(/read.only|Cannot assign/i);
    const { principal } = mutating.seen[0];
    expect(Object.isFrozen(principal)).toBe(true);
    expect(Object.isFrozen(principal?.claims)).toBe(true);
    expect(Object.isFrozen((principal?.claims as { roles: string[] }).roles)).toBe(true);
    expect(() => {
      (principal?.claims as { roles: string[] }).roles.push('admin');
    }).toThrow(TypeError);
    // The caller's own object is not frozen or changed.
    expect(Object.isFrozen(ALICE)).toBe(false);
    expect(ALICE.id).toBe('alice');
  });

  it('writes no principal id or claim into trace spans', async () => {
    const spans: Span[] = [];
    const exporter: TraceExporter = { onSpanStart: () => undefined, onSpanEnd: (span) => void spans.push(span) };
    const whoami = probe('whoami');
    const agent = createAgent({ provider: mockModel([calling('whoami'), 'done']), tools: [whoami.tool], exporter });
    await agent.send('who?', { principal: ALICE });
    expect(spans.length).toBeGreaterThan(0);
    const text = JSON.stringify(spans);
    expect(text).not.toContain('alice');
    expect(text).not.toContain('id.test');
  });
});

describe('sub-agents (N10b)', () => {
  it('an in-process sub-agent, foreground or background, acts for the lead caller', async () => {
    const whoami = probe('whoami');
    const researcher = createAgent({ provider: mockModel([calling('whoami'), 'found', calling('whoami'), 'found again']), tools: [whoami.tool], description: 'Researches' });
    const lead = createAgent({
      provider: mockModel([task('researcher'), task('researcher', { background: true }), { toolCalls: [{ name: 'agent_await', id: 'await', args: { taskId: 'task_2' } }] }, 'done']),
      subagents: { researcher },
    });

    const result = await lead.send('research', { principal: ALICE });

    expect(result.finishReason).toBe('stop');
    expect(whoami.ids()).toEqual(['alice', 'alice']);
  });

  it('a paused sub-agent call resumed by another caller runs for the lead caller, with the decider as approver', async () => {
    const deploy = probe('deploy', { needsApproval: true });
    const researcher = createAgent({ provider: mockModel([calling('deploy'), 'deployed']), tools: [deploy.tool], description: 'Deploys' });
    const lead = createAgent({ provider: mockModel([task('researcher'), 'all done']), subagents: { researcher } });

    const paused = await lead.send('deploy it', { principal: ALICE });
    const [pending] = await lead.approvals.list();
    expect(pending).toMatchObject({ subagentPath: ['researcher'], principal: { id: 'alice' } });

    const result = await lead.approvals.resolve({ id: paused.approvalId!, approved: true }, { principal: BOB });

    expect(result.text).toBe('all done');
    expect(deploy.seen[0].principal?.id).toBe('alice');
    expect(deploy.seen[0].approval?.by?.id).toBe('bob');
  });

  it('a remote sub-agent is not told the lead caller: the remote run sees only its own route auth', async () => {
    const seen: Array<Principal | undefined> = [];
    const remote = createAgent({ provider: mockModel(['42']), instructions: ({ principal }: RunConfigContext) => (seen.push(principal), 'remote') });
    const bodies: string[] = [];
    const fetchRemote: typeof fetch = async (input, init) => {
      const request = new Request(input as string, init);
      const headers: string[] = [];
      request.headers.forEach((value, name) => void headers.push(`${name}: ${value}`));
      bodies.push(`${headers.join(' ')} ${await request.clone().text()}`);
      return serveFetch(request, { name: 'remote', agent: () => remote }, apiToken('t', { id: 'lead-service' }));
    };
    const lead = createAgent({ provider: mockModel([task('remote'), 'done']), subagents: { remote: remoteAgent({ url: 'https://remote.test', auth: 't', fetch: fetchRemote }) } });

    await lead.send('ask remote', { principal: ALICE });

    expect(seen).toEqual([{ id: 'lead-service', type: 'service', authenticator: 'api-token' }]);
    expect(bodies.join('')).not.toContain('alice');
  });
});

describe('pause and resume (N10b)', () => {
  it('a static run paused for A and approved by B runs the call, and the rest of the turn, for A; B is the approver', async () => {
    const send = probe('send_email', { needsApproval: true });
    const log = probe('log');
    const approvalStore = new InMemoryApprovalStore();
    const agent = createAgent({ provider: mockModel([calling('send_email', 'log'), 'sent']), tools: [send.tool, log.tool], approvalStore });

    const paused = await agent.send('email Sam', { principal: ALICE });
    expect(paused.finishReason).toBe('awaiting-approval');
    expect((await agent.approvals.list())[0].principal).toEqual(ALICE);

    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true }, { principal: BOB });

    expect(result.text).toBe('sent');
    expect(send.seen[0].principal).toEqual(ALICE);
    expect(send.seen[0].approval).toEqual({ by: BOB });
    expect(log.ids()).toEqual(['alice']);
    expect(log.seen[0].approval).toBeUndefined();
  });

  it('the approval survives a restart: a new agent resolves it and the run still acts for A', async () => {
    const records = new Map<string, string>();
    // A JSON round-trip, like any durable approval store.
    const approvalStore: ApprovalStore = {
      save: async (pending, snapshot) => void records.set(pending.id, JSON.stringify({ pending, snapshot })),
      resolve: async (id) => {
        const record = records.get(id);
        records.delete(id);
        return record ? (JSON.parse(record) as { pending: PendingApproval; snapshot: ExecutionSnapshot }) : null;
      },
    };
    const send = probe('send_email', { needsApproval: true });
    const paused = await createAgent({ provider: mockModel([calling('send_email')]), tools: [send.tool], approvalStore }).send('email', { principal: ALICE });

    const restarted = createAgent({ provider: mockModel(['sent']), tools: [send.tool], approvalStore });
    const result = await restarted.approvals.answer({ id: paused.approvalId!, answer: 'ok' }, { principal: BOB });

    expect(result.text).toBe('sent');
    expect(send.seen[0].principal).toEqual(ALICE);
    expect(send.seen[0].approval).toEqual({ note: 'ok', by: BOB });
  });

  it('an approval snapshot saved before N10b resumes with no principal', async () => {
    const records = new Map<string, { pending: PendingApproval; snapshot: ExecutionSnapshot }>();
    const approvalStore: ApprovalStore = {
      save: async (pending, snapshot) => {
        const { principal: _p, ...oldPending } = pending;
        const { principal: _s, ...oldSnapshot } = snapshot;
        records.set(pending.id, { pending: oldPending, snapshot: { ...oldSnapshot, pendingToolCall: oldPending } });
      },
      resolve: async (id) => records.get(id) ?? null,
    };
    const send = probe('send_email', { needsApproval: true });
    const agent = createAgent({ provider: mockModel([calling('send_email'), 'sent']), tools: [send.tool], approvalStore });
    const paused = await agent.send('email', { principal: ALICE });
    await agent.approvals.resolve({ id: paused.approvalId!, approved: true }, { principal: BOB });
    expect(send.seen[0]).not.toHaveProperty('principal');
    expect(send.seen[0].approval?.by).toEqual(BOB);
  });

  it('an approve callback sees whose call it is; its decisions have no approver', async () => {
    const requests: PendingApproval[] = [];
    const send = probe('send_email', { needsApproval: true });
    const agent = createAgent({
      provider: mockModel([calling('send_email'), 'sent']),
      tools: [send.tool],
      approve: (request) => (requests.push(request), request.principal?.id === 'alice'),
    });
    const result = await agent.send('email', { principal: ALICE });
    expect(result.text).toBe('sent');
    expect(requests[0].principal).toEqual(ALICE);
    expect(send.seen[0].principal).toEqual(ALICE);
    expect(send.seen[0].approval).toEqual({});
  });

  it('a crashed checkpointed run (SqliteStore on disk) finished by agent.resume() in a new agent runs its tools for the original principal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lousho-n10b-'));
    temps.push(dir);
    const file = join(dir, 'agent.db');
    const a = probe('a');
    const b = probe('b', { crashOnce: true });
    const crashing = new SqliteStore(file);
    const first = createAgent({ provider: mockModel([calling('a'), calling('b')]), tools: [a.tool, b.tool], store: crashing });
    await expect(first.send('run the job', { sessionId: 'job-1', principal: ALICE })).rejects.toThrow('process died');
    crashing.close();

    const reopened = new SqliteStore(file);
    try {
      expect((await reopened.checkpoints.load('job-1'))?.principal).toEqual(ALICE);
      const agent = createAgent({ provider: mockModel(['finished']), tools: [a.tool, b.tool], store: reopened });
      // Another caller may not continue it.
      await expect(agent.send('and more', { sessionId: 'job-1', principal: BOB })).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID' });
      const result = await agent.resume('job-1');

      expect(result?.text).toBe('finished');
      expect(a.ids()).toEqual(['alice']);
      expect(b.ids()).toEqual(['alice', 'alice']);
    } finally {
      reopened.close();
    }
  });

  it('a checkpoint written before N10b resumes with no principal; continuing it as the same caller is allowed', async () => {
    const store = memoryStore();
    const b = probe('b', { crashOnce: true });
    await expect(createAgent({ provider: mockModel([calling('b')]), tools: [b.tool], store }).send('go', { sessionId: 'old', principal: ALICE })).rejects.toThrow();
    const saved = (await store.checkpoints!.load('old'))!;
    const { principal: _dropped, ...old } = saved;
    await store.checkpoints!.save('old', old);

    await createAgent({ provider: mockModel(['done']), tools: [b.tool], store }).resume('old');
    expect(b.seen[1]).not.toHaveProperty('principal');

    // A run saved with A continues when A sends again.
    const same = probe('same', { crashOnce: true });
    await expect(createAgent({ provider: mockModel([calling('same')]), tools: [same.tool], store }).send('go', { sessionId: 'same', principal: ALICE })).rejects.toThrow();
    const again = await createAgent({ provider: mockModel(['ok']), tools: [same.tool], store }).send('go on', { sessionId: 'same', principal: { ...ALICE, claims: {} } });
    expect(again.text).toBe('ok');
    expect(same.ids()).toEqual(['alice', 'alice']);
  });

  it("a fork of a checkpointed run keeps the source's principal; session.fork() copies only the conversation", async () => {
    const store = memoryStore();
    const whoami = probe('whoami');
    const agent = createAgent({ provider: mockModel([calling('whoami'), 'one', 'forked', calling('whoami'), 'two']), tools: [whoami.tool], store });
    await agent.send('who?', { sessionId: 'job', principal: ALICE });
    const fork = await agent.fork('job', { fromStep: 1 });
    expect(fork.checkpoint.principal).toEqual(ALICE);
    await expect(agent.send('x', { sessionId: fork.sessionId, principal: BOB })).rejects.toMatchObject({ code: 'LOUSHO_CONFIG_INVALID' });
    expect((await agent.resume(fork.sessionId))?.text).toBe('forked');

    const session = agent.session({ id: 'chat' });
    const copy = await session.fork({ fromStep: 0 });
    await copy.send('who?', { principal: BOB });
    expect(whoami.ids()).toEqual(['alice', 'bob']);
  });
});

describe('approvers over HTTP and channels (N10b)', () => {
  it("the approvals route passes route auth's principal as the approver; the run keeps its own", async () => {
    const deploy = probe('deploy', { needsApproval: true });
    const agent = createAgent({ provider: mockModel([calling('deploy'), 'shipped']), tools: [deploy.tool], store: memoryStore() });
    const { handler } = createRouteHandler(agent, { auth: [apiToken('alice-token', { id: 'alice' }), apiToken('bob-token', { id: 'bob' })] });
    const as = (token: string) => ({ authorization: `Bearer ${token}` });

    await (await handler(request('/api/agent/chat', { sessionId: 'h1', input: 'deploy' }, as('alice-token')))).text();
    const [pending] = await agent.approvals.list();
    expect(pending.principal).toMatchObject({ id: 'alice', authenticator: 'api-token' });
    // A body field cannot name the approver or the run's caller.
    const body = { approved: true, principal: { id: 'root' }, approver: { id: 'root' } };
    await (await handler(request(`/api/agent/chat/h1/approvals/${pending.id}`, body, as('bob-token')))).text();

    expect(deploy.seen[0].principal).toEqual({ id: 'alice', type: 'service', authenticator: 'api-token' });
    expect(deploy.seen[0].approval?.by).toEqual({ id: 'bob', type: 'service', authenticator: 'api-token' });
  });

  it("a channel's clicking user is the approver; the turn's sender stays the principal", async () => {
    const deploy = probe('deploy', { needsApproval: true });
    const agent = createAgent({ provider: mockModel([calling('deploy'), 'shipped']), tools: [deploy.tool] });
    let approvalId = '';
    const channel = defineChannel({
      name: 'chat',
      async parse(req) {
        const body = JSON.parse(req.text) as { user: string; text?: string; click?: string };
        const inbound = { sessionKey: 'room', input: body.text ?? '', replyTo: 'room', principal: { id: body.user, type: 'user' as const, authenticator: 'chat' } };
        return body.click ? { decision: { id: body.click, approved: true }, inbound, approver: { id: body.user } } : inbound;
      },
      async reply(ctx) {
        if (ctx.approval) approvalId = ctx.approval.id;
      },
    });
    const handler = mountChannels(agent, [channel]);

    await post(handler, '/channels/chat', { user: 'U1', text: 'deploy' });
    await post(handler, '/channels/chat', { user: 'U9', click: approvalId });

    expect(deploy.seen[0].principal).toEqual({ id: 'U1', type: 'user', authenticator: 'chat' });
    expect(deploy.seen[0].approval?.by).toEqual({ id: 'U9', type: 'user', authenticator: 'chat' });
  });
});

const request = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://app.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

/** Drives a channels handler with a fake `node:http` request and response. */
async function post(handler: ChannelsHandler, path: string, body: unknown): Promise<void> {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', url: path, headers: {} });
  const res = { writeHead: () => res, end: () => res };
  await handler(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse);
}
