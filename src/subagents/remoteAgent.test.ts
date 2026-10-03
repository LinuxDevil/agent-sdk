import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createAgent, type SimpleAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockTurn } from '../testing';
import { serveFetch, type ServeAuth } from '../server/fetchRoutes';
import { apiToken, basic, jwt, type Principal } from '../auth';
import type { RunConfigContext } from '../createAgent';
import type { Message } from '../providers';
import type { AgentEventUsage } from '../execution/agentEvents';
import { memoryStore } from '../storage/agentStore';
import { SqliteStore } from '../storage/sqlite';
import { remoteAgent } from './remoteAgent';

const TOKEN = 'secret-token-123';
type Fetch = typeof fetch;

/** An in-process deployed agent: the real `/chat` routes (with bearer auth) in front of `agent`. */
function deployed(agent: SimpleAgent, token: ServeAuth = TOKEN): { fetch: Fetch; requests: Request[] } {
  const requests: Request[] = [];
  const handler: Fetch = async (input, init) => {
    const request = new Request(input as string, init);
    requests.push(request.clone());
    return serveFetch(request, { name: 'remote', agent: () => agent }, token);
  };
  return { fetch: handler, requests };
}

const delegate = (prompt = 'research this') => ({
  text: 'asking',
  toolCalls: [{ name: 'task', args: { agent: 'remote', prompt, description: 'remote task' } }],
});

function lead(remote: ReturnType<typeof remoteAgent>, turns: MockTurn[] = [delegate(), 'done']) {
  const model = mockModel(turns);
  return { model, agent: createAgent({ provider: model, instructions: 'lead', subagents: { remote } }) };
}

const toolResult = (messages: readonly Message[]) => JSON.parse(messages.find((m) => m.role === 'tool')?.content as string) as unknown;
const errorMessage = (messages: readonly Message[]) => (toolResult(messages) as { message: string }).message;

describe('remoteAgent (LOU-Y7)', () => {
  it('runs a task on the deployed agent through its session API and returns its final text', async () => {
    const remoteModel = mockModel(['The answer is 42.']);
    const server = deployed(createAgent({ provider: remoteModel, instructions: 'remote' }));
    const { agent, model } = lead(remoteAgent({ url: 'https://remote.test/', auth: TOKEN, description: 'A remote researcher', fetch: server.fetch }));

    const result = await agent.send('go');

    expect(String(toolResult(result.messages))).toMatch(/^The answer is 42\.\n\n\[remote sub-agent 'remote': session 'task_[\w-]+', finish reason 'stop', taskId 'task_1'\]$/);
    expect(result.text).toBe('done');
    expect(remoteModel.calls[0].messages.at(-1)).toEqual({ role: 'user', content: 'research this' });
    expect(model.calls[0].messages[0].content).toContain('- remote: A remote researcher');
    const [request] = server.requests;
    expect(request.url).toBe('https://remote.test/chat');
    expect(request.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    const body = (await request.json()) as { sessionId: string; input: string };
    expect(body.input).toBe('research this');
    expect(body.sessionId).toMatch(/^task_/);
  });

  it('resuming a task continues its remote session (LOU-Y7.2)', async () => {
    const remoteModel = mockModel(['First answer.', 'Second answer.']);
    const server = deployed(createAgent({ provider: remoteModel, instructions: 'remote', store: memoryStore() }));
    const resume = { toolCalls: [{ name: 'task', args: { agent: 'remote', prompt: 'and then?', description: 'more', taskId: 'task_1' } }] };
    const { agent } = lead(remoteAgent({ url: 'https://remote.test', auth: TOKEN, fetch: server.fetch }), [delegate(), resume, 'done']);

    const result = await agent.send('go');

    const [first, second] = await Promise.all(server.requests.map(async (r) => ((await r.json()) as { sessionId: string }).sessionId));
    expect(second).toBe(first);
    expect(remoteModel.calls[1].messages.map((m) => m.content)).toEqual(['remote', 'research this', 'First answer.', 'and then?']);
    const last = JSON.parse(result.messages.filter((m) => m.role === 'tool').at(-1)?.content as string) as string;
    expect(last).toMatch(/^Second answer\.\n\n\[remote sub-agent 'remote': session 'task_[\w-]+', finish reason 'stop', taskId 'task_1'\]$/);
  });

  it('accepts a token function and extra headers', async () => {
    const server = deployed(createAgent({ provider: mockModel(['ok']), instructions: 'remote' }));
    const { agent } = lead(remoteAgent({ url: 'https://remote.test', auth: async () => TOKEN, headers: { 'X-Team': 'a' }, fetch: server.fetch }));
    await agent.send('go');
    expect(server.requests[0].headers.get('x-team')).toBe('a');
    expect(server.requests[0].headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('returns a structured coded tool error on 401 and never exposes the token', async () => {
    const server = deployed(createAgent({ provider: mockModel(['unused']), instructions: 'remote' }), 'another-token');
    const { agent } = lead(remoteAgent({ url: 'https://remote.test', auth: TOKEN, fetch: server.fetch }));
    const events: string[] = [];

    const run = agent.stream('go');
    for await (const event of run) events.push(JSON.stringify(event));
    const result = await run.result;

    expect(toolResult(result.messages)).toMatchObject({ toolName: 'task', kind: 'execution' });
    expect(errorMessage(result.messages)).toContain('LOUSHO_REMOTE_UNAUTHORIZED');
    expect(errorMessage(result.messages)).toContain('401');
    expect(JSON.stringify(result.messages) + events.join('')).not.toContain(TOKEN);
  });

  it('reports a network error, scrubbing the token from the message', async () => {
    const failing: Fetch = async () => {
      throw new TypeError(`connect ECONNREFUSED while sending ${TOKEN}`);
    };
    const { agent } = lead(remoteAgent({ url: 'https://remote.test', auth: TOKEN, fetch: failing }));
    const message = errorMessage((await agent.send('go')).messages);
    expect(message).toContain('could not be reached');
    expect(message).toContain('ECONNREFUSED');
    expect(message).not.toContain(TOKEN);
  });

  it('fails when the remote run ends in an error', async () => {
    const server = deployed(createAgent({ provider: mockModel([{ error: new Error('model exploded') }]), instructions: 'remote' }));
    const { agent } = lead(remoteAgent({ url: 'https://remote.test', auth: TOKEN, fetch: server.fetch }));
    const message = errorMessage((await agent.send('go')).messages);
    expect(message).toContain('LOUSHO_REMOTE_REQUEST_FAILED');
    expect(message).toContain('model exploded');
  });

  it('fails on a malformed response', async () => {
    const garbage: Fetch = async () => new Response('hello', { status: 200 });
    const { agent } = lead(remoteAgent({ url: 'https://remote.test', fetch: garbage }));
    expect(errorMessage((await agent.send('go')).messages)).toContain('closed the stream without a final event');
  });

  it('says when the remote agent awaits approval and the caller cannot pause, with its session id', async () => {
    const deploy = defineTool({ name: 'deploy', description: 'Deploys', input: z.object({}), needsApproval: true, execute: () => 'deployed' });
    const remoteModel = mockModel([{ toolCalls: [{ name: 'deploy' }] }, 'never']);
    const server = deployed(createAgent({ provider: remoteModel, instructions: 'remote', tools: [deploy] }));
    const remote = remoteAgent({ url: 'https://remote.test', auth: TOKEN, fetch: server.fetch });
    const error = await remote.run('go', { name: 'remote', taskId: 'task_1' }).then(
      () => new Error('expected the run to reject'),
      (e: unknown) => e as Error
    );
    expect(error.message).toContain('awaiting approval');
    expect(error.message).toMatch(/session 'task_[\w-]+'/);
    expect(error).toMatchObject({ code: 'LOUSHO_SESSION_AWAITING_APPROVAL' });
    expect(error.message).toContain("then continue task 'task_1'");
  });

  it("aborts the in-flight request when the lead run's signal aborts", async () => {
    let seen: AbortSignal | undefined | null;
    const hanging: Fetch = (_input, init) => {
      seen = init?.signal;
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    };
    const { agent } = lead(remoteAgent({ url: 'https://remote.test', fetch: hanging }));
    const controller = new AbortController();
    const run = agent.send('go', { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    const result = await run;
    expect(seen?.aborted).toBe(true);
    expect(result.finishReason).toBe('aborted');
  });

  it('works as a background sub-agent', async () => {
    const server = deployed(createAgent({ provider: mockModel(['bg answer']), instructions: 'remote' }));
    const remote = remoteAgent({ url: 'https://remote.test', auth: TOKEN, fetch: server.fetch });
    const start = { name: 'task', args: { agent: 'remote', prompt: 'p', description: 'd', background: true } };
    const { agent } = lead(remote, [{ toolCalls: [start] }, { toolCalls: [{ name: 'agent_await', args: { taskId: 'task_1' } }] }, 'finished']);
    const result = await agent.send('go');
    const awaited = result.messages.filter((m) => m.role === 'tool').at(-1)?.content as string;
    expect(awaited).toContain('bg answer');
  });
});

describe('remote sub-agent approvals through the lead run (LOU-Y7.3)', () => {
  /** A deployed agent with a `deploy` tool that needs approval; `turns` are its model's. */
  function approvingRemote(turns: MockTurn[], auth: ServeAuth = TOKEN) {
    const runs: string[] = [];
    const deploy = defineTool({
      name: 'deploy',
      description: 'Deploys',
      input: z.object({ env: z.string() }),
      needsApproval: true,
      execute: ({ env }) => (runs.push(env), `deployed to ${env}`),
    });
    const model = mockModel(turns);
    const server = deployed(createAgent({ provider: model, instructions: 'remote', tools: [deploy] }), auth);
    return { model, runs, server };
  }
  const deployCall = (env = 'prod'): MockTurn => ({ toolCalls: [{ name: 'deploy', args: { env } }] });
  const taskResult = (messages: readonly Message[]) => String(toolResult(messages));

  it('pauses the lead on the remote approval, naming the remote agent, tool and input; approving returns the continuation', async () => {
    const { server, runs } = approvingRemote([deployCall(), 'Deployed to prod.']);
    const { agent } = lead(remoteAgent({ url: 'https://remote.test', auth: TOKEN, fetch: server.fetch }));

    const paused = await agent.send('go');
    expect(paused.finishReason).toBe('awaiting-approval');
    const [pending] = await agent.approvals.list();
    expect(pending).toMatchObject({ id: paused.approvalId, toolName: 'deploy', args: { env: 'prod' }, subagentPath: ['remote'] });
    expect(runs).toEqual([]);

    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(runs).toEqual(['prod']);
    expect(result.text).toBe('done');
    expect(taskResult(result.messages)).toMatch(/^Deployed to prod\.\n\n\[remote sub-agent 'remote': session 'task_[\w-]+', finish reason 'stop', taskId 'task_1'\]$/);
    const approval = server.requests[1];
    expect(approval.url).toMatch(new RegExp(`/chat/task_[\\w-]+/approvals/${paused.approvalId}$`));
    expect(approval.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(await approval.json()).toEqual({ approved: true });
  });

  it('works against a server whose auth is a list (N10a): the bearer token is its apiToken() entry, approvals included', async () => {
    const authList = [basic({ users: { ops: 'pw' } }), jwt({ secret: 'a-jwt-secret-that-is-at-least-32-bytes', audience: 'agent' }), apiToken(TOKEN)];
    const { server, runs } = approvingRemote([deployCall(), 'Deployed to prod.'], authList);
    const { agent } = lead(remoteAgent({ url: 'https://remote.test', auth: TOKEN, fetch: server.fetch }));

    const paused = await agent.send('go');
    expect(paused.finishReason).toBe('awaiting-approval');
    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });
    expect(runs).toEqual(['prod']);
    expect(taskResult(result.messages)).toMatch(/^Deployed to prod\./);

    const { agent: refused } = lead(remoteAgent({ url: 'https://remote.test', auth: 'wrong-token', fetch: server.fetch }));
    expect(errorMessage((await refused.send('go')).messages)).toContain('401');
  });

  it('rejecting on the lead rejects the remote call', async () => {
    const { server, runs, model } = approvingRemote([deployCall(), 'Not deployed.']);
    const { agent } = lead(remoteAgent({ url: 'https://remote.test', auth: TOKEN, fetch: server.fetch }));
    const paused = await agent.send('go');

    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: false, note: 'not today' });

    expect(runs).toEqual([]);
    expect(taskResult(result.messages)).toMatch(/^Not deployed\./);
    expect(JSON.stringify(model.calls[1].messages)).toContain('rejected');
  });

  it('a continuation that pauses again pauses the lead again', async () => {
    const { server, runs } = approvingRemote([deployCall('staging'), deployCall('prod'), 'Both deployed.']);
    const { agent } = lead(remoteAgent({ url: 'https://remote.test', auth: TOKEN, fetch: server.fetch }));
    const first = await agent.send('go');

    const second = await agent.approvals.resolve({ id: first.approvalId!, approved: true });
    expect(second.finishReason).toBe('awaiting-approval');
    expect(second.approvalId).not.toBe(first.approvalId);
    expect((await agent.approvals.list())[0]).toMatchObject({ toolName: 'deploy', args: { env: 'prod' } });

    const result = await agent.approvals.resolve({ id: second.approvalId!, approved: true });
    expect(runs).toEqual(['staging', 'prod']);
    expect(taskResult(result.messages)).toMatch(/^Both deployed\./);
  });

  it('a background remote task that pauses pauses the lead at agent_await, and approving it returns the answer there (M4)', async () => {
    const { server, runs } = approvingRemote([deployCall(), 'Deployed in the background.']);
    const start = { name: 'task', args: { agent: 'remote', prompt: 'deploy', description: 'd', background: true } };
    const { agent } = lead(remoteAgent({ url: 'https://remote.test', auth: TOKEN, fetch: server.fetch }), [
      { toolCalls: [start] },
      { toolCalls: [{ name: 'agent_await', args: { taskId: 'task_1' } }] },
      'done',
    ]);

    const paused = await agent.send('go');
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(await agent.approvals.list()).toEqual([expect.objectContaining({ id: paused.approvalId, toolName: 'deploy', subagentPath: ['remote'] })]);

    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(runs).toEqual(['prod']);
    expect(result.text).toBe('done');
    const awaited = JSON.parse(result.messages.filter((m) => m.role === 'tool').at(-1)?.content as string) as { status: string; result: string };
    expect(awaited).toMatchObject({ status: 'done', result: expect.stringMatching(/^Deployed in the background\./) });
  });

  it('is decided from a fresh lead agent on the same SQLite store, without the token being stored', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lousho-y73-'));
    const file = join(dir, 'agent.db');
    const { server, runs } = approvingRemote([deployCall(), 'Deployed.']);
    const subagents = () => ({ remote: remoteAgent({ url: 'https://remote.test', auth: TOKEN, fetch: server.fetch }) });
    try {
      const first = new SqliteStore(file);
      const paused = await createAgent({ provider: mockModel([delegate()]), store: first, subagents: subagents() }).session({ id: 'chat' }).send('go');
      first.close();
      const stored = readdirSync(dir).map((name) => readFileSync(join(dir, name)).toString('latin1')).join('');
      expect(stored).toContain(paused.approvalId!);
      expect(stored).not.toContain(TOKEN);

      const second = new SqliteStore(file);
      const fresh = createAgent({ provider: mockModel(['done']), store: second, subagents: subagents() });
      const result = await fresh.approvals.resolve({ id: paused.approvalId!, approved: true });
      second.close();

      expect(runs).toEqual(['prod']);
      expect(result.text).toBe('done');
      expect(taskResult(result.messages)).toMatch(/^Deployed\.\n\n.*taskId 'task_1'/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a remote 401 while resolving is a coded tool error on the task call, and the lead run continues', async () => {
    const { server, runs } = approvingRemote([deployCall(), 'never']);
    let calls = 0;
    const auth = () => (calls++ === 0 ? TOKEN : 'stale-token');
    const { agent } = lead(remoteAgent({ url: 'https://remote.test', auth, fetch: server.fetch }));
    const paused = await agent.send('go');

    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(runs).toEqual([]);
    expect(result.text).toBe('done');
    expect(toolResult(result.messages)).toMatchObject({ toolName: 'task' });
    expect(errorMessage(result.messages)).toContain('LOUSHO_REMOTE_UNAUTHORIZED');
    expect(JSON.stringify(result.messages)).not.toContain('stale-token');
  });

  it('a remote approval no longer pending is a coded tool error on the task call', async () => {
    const { server } = approvingRemote([deployCall(), 'decided remotely']);
    const { agent } = lead(remoteAgent({ url: 'https://remote.test', auth: TOKEN, fetch: server.fetch }));
    const paused = await agent.send('go');
    const { sessionId } = (await server.requests[0].json()) as { sessionId: string };
    const direct = { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ approved: true }) };
    await (await server.fetch(`https://remote.test/chat/${sessionId}/approvals/${paused.approvalId}`, direct)).text();

    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(result.text).toBe('done');
    expect(errorMessage(result.messages)).toContain('LOUSHO_REMOTE_REQUEST_FAILED');
    expect(errorMessage(result.messages)).toContain('404');
  });

  it('streams the resolve on the lead (streamResolve)', async () => {
    const { server } = approvingRemote([deployCall(), 'Deployed.']);
    const { agent } = lead(remoteAgent({ url: 'https://remote.test', auth: TOKEN, fetch: server.fetch }));
    const paused = await agent.send('go');

    const run = agent.approvals.streamResolve({ id: paused.approvalId!, approved: true });
    const types: string[] = [];
    for await (const event of run) types.push(event.type);
    const result = await run.result;

    expect(result.text).toBe('done');
    expect(types).toContain('tool.done');
    expect(types.at(-1)).toBe('run.done');
    expect(taskResult(result.messages)).toMatch(/^Deployed\./);
  });

  it('surfaces a remote ask_question as a question on the lead and forwards the answer', async () => {
    const remoteModel = mockModel([{ toolCalls: [{ name: 'ask_question', args: { question: 'Which env?' } }] }, 'Using staging.']);
    const server = deployed(createAgent({ provider: remoteModel, instructions: 'remote', askQuestion: true }));
    const { agent } = lead(remoteAgent({ url: 'https://remote.test', auth: TOKEN, fetch: server.fetch }));
    const paused = await agent.send('go');
    expect((await agent.approvals.list())[0]).toMatchObject({ kind: 'question', question: { text: 'Which env?' }, subagentPath: ['remote'] });

    const result = await agent.approvals.answer({ id: paused.approvalId!, answer: 'staging' });

    expect(taskResult(result.messages)).toMatch(/^Using staging\./);
    expect(JSON.stringify(remoteModel.calls[1].messages)).toContain('staging');
  });

  it("returns a remote agent's output object as JSON with the footer (V4.2 shape)", async () => {
    const output = z.object({ city: z.string(), tempC: z.number() });
    const server = deployed(createAgent({ provider: mockModel(['{"city":"Oslo","tempC":-3}']), instructions: 'remote', output }));
    const { agent } = lead(remoteAgent({ url: 'https://remote.test', auth: TOKEN, fetch: server.fetch }));
    const result = await agent.send('go');
    expect(taskResult(result.messages)).toMatch(/^\{"city":"Oslo","tempC":-3\}\n\n\[remote sub-agent 'remote': session 'task_[\w-]+', finish reason 'stop', taskId 'task_1'\]$/);
  });
});

describe("remote sub-agent usage in the lead's totals (M10b)", () => {
  it("adds the remote run's tokens behind an auth list too, and the remote run sees the api-token principal (N10a)", async () => {
    const seen: Array<Principal | undefined> = [];
    const remoteAgentServer = createAgent({
      provider: mockModel([{ text: 'The answer is 42.', ...used(100, 50) }]),
      instructions: ({ principal }: RunConfigContext) => (seen.push(principal), 'remote'),
    });
    const server = deployed(remoteAgentServer, [basic({ users: { ops: 'pw' } }), apiToken(TOKEN, { id: 'lead' })]);
    const { agent } = lead(remoteAgent({ url: 'https://remote.test', auth: TOKEN, fetch: server.fetch }), leadTurns());

    const { usage } = await agent.send('go');

    expect(usage.byModel['remote:remote']).toEqual({ inputTokens: 100, outputTokens: 50, calls: 1, costUsd: undefined });
    expect(seen).toEqual([{ id: 'lead', type: 'service', authenticator: 'api-token' }]);
  });

  /** The lead delegates once; its own two model calls spend 10/1 and 20/2 tokens. */
  const leadTurns = (): MockTurn[] => [{ ...delegate(), usage: { inputTokens: 10, outputTokens: 1 } }, { text: 'done', usage: { inputTokens: 20, outputTokens: 2 } }];
  const used = (inputTokens: number, outputTokens: number) => ({ usage: { inputTokens, outputTokens } });

  /** The deployed agent's stream with its `run.done` usage replaced by `usage` (removed when `undefined`, as an older server sends it). */
  function rewriteUsage(fetcher: Fetch, usage: AgentEventUsage | undefined): Fetch {
    return async (input, init) => {
      const response = await fetcher(input, init);
      const body = (await response.text())
        .split('\n\n')
        .map((frame) => {
          if (!frame.startsWith('data: ')) return frame;
          const event = JSON.parse(frame.slice(6)) as { type: string; usage?: unknown };
          if (event.type === 'run.done') event.usage = usage;
          return `data: ${JSON.stringify(event)}`;
        })
        .join('\n\n');
      return new Response(body, { status: response.status, headers: response.headers });
    };
  }

  it("adds the remote run's tokens to the lead's totals, under byModel['remote:<name>'] and usage.delegated", async () => {
    const server = deployed(createAgent({ provider: mockModel([{ text: 'The answer is 42.', ...used(100, 50) }]), instructions: 'remote' }));
    const { agent } = lead(remoteAgent({ url: 'https://remote.test', auth: TOKEN, fetch: server.fetch }), leadTurns());

    const { usage } = await agent.send('go');

    expect(usage).toMatchObject({ inputTokens: 130, outputTokens: 53, totalTokens: 183, modelCalls: 3, promptTokens: 130, completionTokens: 53 });
    expect(usage.byModel['remote:remote']).toEqual({ inputTokens: 100, outputTokens: 50, calls: 1, costUsd: undefined });
    expect(usage.delegated).toMatchObject({ inputTokens: 100, outputTokens: 50, totalTokens: 150, modelCalls: 1, runs: 1 });
    const own = Object.entries(usage.byModel).filter(([model]) => model !== 'remote:remote');
    expect(own.reduce((sum, [, entry]) => sum + entry.inputTokens, 0)).toBe(30);
  });

  it("passes each turn's usage to onUsage and keeps the remote's reported cost", async () => {
    const reported: AgentEventUsage = { promptTokens: 7, completionTokens: 3, totalTokens: 10, inputTokens: 7, outputTokens: 3, estimated: false, costUsd: 0.25, modelCalls: 2 };
    const server = deployed(createAgent({ provider: mockModel(['ok', 'ok']), instructions: 'remote' }));
    const remote = remoteAgent({ url: 'https://remote.test', auth: TOKEN, fetch: rewriteUsage(server.fetch, reported) });
    const seen: AgentEventUsage[] = [];
    await expect(remote.run('go', { onUsage: (usage) => seen.push(usage) })).resolves.toContain('ok');
    expect(seen).toEqual([reported]);

    const model = mockModel([delegate(), 'done']);
    const { usage } = await createAgent({ provider: model, instructions: 'lead', subagents: { remote } }).send('go');
    expect(usage.byModel['remote:remote']).toEqual({ inputTokens: 7, outputTokens: 3, calls: 2, costUsd: 0.25 });
    expect(usage.delegated).toMatchObject({ costUsd: 0.25, modelCalls: 2 });
  });

  it('adds each turn of a remote run paused for approval once: the continuation adds only what it spent after the pause', async () => {
    const deploy = defineTool({ name: 'deploy', description: 'Deploys', input: z.object({}), needsApproval: true, execute: () => 'deployed' });
    const remoteModel = mockModel([{ toolCalls: [{ name: 'deploy' }], ...used(100, 10) }, { text: 'Deployed.', ...used(200, 20) }]);
    const server = deployed(createAgent({ provider: remoteModel, instructions: 'remote', tools: [deploy] }));
    const { agent } = lead(remoteAgent({ url: 'https://remote.test', auth: TOKEN, fetch: server.fetch }), leadTurns());

    const paused = await agent.send('go');
    expect(paused.finishReason).toBe('awaiting-approval');
    expect(paused.usage.byModel['remote:remote']).toMatchObject({ inputTokens: 100, outputTokens: 10, calls: 1 });

    const { usage } = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(usage).toMatchObject({ inputTokens: 330, outputTokens: 33 });
    expect(usage.byModel['remote:remote']).toMatchObject({ inputTokens: 300, outputTokens: 30, calls: 2 });
    expect(usage.delegated).toMatchObject({ inputTokens: 300, outputTokens: 30, modelCalls: 2 });
  });

  it('a continuation that pauses again still adds every remote call once', async () => {
    const deploy = defineTool({ name: 'deploy', description: 'Deploys', input: z.object({ env: z.string() }), needsApproval: true, execute: ({ env }) => env });
    const call = (env: string): MockTurn => ({ toolCalls: [{ name: 'deploy', args: { env } }], ...used(100, 10) });
    const server = deployed(createAgent({ provider: mockModel([call('staging'), call('prod'), { text: 'Both.', ...used(100, 10) }]), instructions: 'remote', tools: [deploy] }));
    const { agent } = lead(remoteAgent({ url: 'https://remote.test', auth: TOKEN, fetch: server.fetch }));

    const first = await agent.send('go');
    const second = await agent.approvals.resolve({ id: first.approvalId!, approved: true });
    expect(second.usage.byModel['remote:remote']).toMatchObject({ inputTokens: 200, calls: 2 });
    const { usage } = await agent.approvals.resolve({ id: second.approvalId!, approved: true });

    expect(usage.byModel['remote:remote']).toMatchObject({ inputTokens: 300, outputTokens: 30, calls: 3 });
  });

  it("adds a background remote task's usage when it finishes", async () => {
    const server = deployed(createAgent({ provider: mockModel([{ text: 'bg answer', ...used(100, 50) }]), instructions: 'remote' }));
    const start = { name: 'task', args: { agent: 'remote', prompt: 'p', description: 'd', background: true } };
    const turns: MockTurn[] = [{ toolCalls: [start] }, { toolCalls: [{ name: 'agent_await', args: { taskId: 'task_1' } }] }, 'finished'];
    const { agent } = lead(remoteAgent({ url: 'https://remote.test', auth: TOKEN, fetch: server.fetch }), turns);

    const { usage } = await agent.send('go');

    expect(usage.byModel['remote:remote']).toMatchObject({ inputTokens: 100, outputTokens: 50, calls: 1 });
    expect(usage.delegated).toMatchObject({ inputTokens: 100, runs: 1 });
  });

  it('adds nothing, and does not fail, when the remote reports no usage (older server)', async () => {
    const server = deployed(createAgent({ provider: mockModel([{ text: 'old answer', ...used(100, 50) }]), instructions: 'remote' }));
    const { agent } = lead(remoteAgent({ url: 'https://remote.test', auth: TOKEN, fetch: rewriteUsage(server.fetch, undefined) }), leadTurns());

    const result = await agent.send('go');

    expect(String(toolResult(result.messages))).toMatch(/^old answer/);
    expect(result.usage).toMatchObject({ inputTokens: 30, outputTokens: 3 });
    expect(result.usage.byModel['remote:remote']).toBeUndefined();
    expect(result.usage.delegated).toBeUndefined();
  });
});
