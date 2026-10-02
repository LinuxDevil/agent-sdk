import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createAgent, type SimpleAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockTurn } from '../testing';
import { serveFetch } from '../server/fetchRoutes';
import type { Message } from '../providers';
import { memoryStore } from '../storage/agentStore';
import { SqliteStore } from '../storage/sqlite';
import { remoteAgent } from './remoteAgent';

const TOKEN = 'secret-token-123';
type Fetch = typeof fetch;

/** An in-process deployed agent: the real `/chat` routes (with bearer auth) in front of `agent`. */
function deployed(agent: SimpleAgent, token = TOKEN): { fetch: Fetch; requests: Request[] } {
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

    const result = await agent.send('go', { onEvent: (e) => events.push(JSON.stringify(e)) });

    expect(toolResult(result.messages)).toMatchObject({ toolName: 'task', kind: 'execution' });
    expect(errorMessage(result.messages)).toContain('LOUSHY_REMOTE_UNAUTHORIZED');
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
    expect(message).toContain('LOUSHY_REMOTE_REQUEST_FAILED');
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
    const error = await remote.run('go', { name: 'remote', taskId: 'task_1' }).catch((e: unknown) => e as Error);
    expect(error.message).toContain('awaiting approval');
    expect(error.message).toMatch(/session 'task_[\w-]+'/);
    expect(error).toMatchObject({ code: 'LOUSHY_SESSION_AWAITING_APPROVAL' });
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
  function approvingRemote(turns: MockTurn[]) {
    const runs: string[] = [];
    const deploy = defineTool({
      name: 'deploy',
      description: 'Deploys',
      input: z.object({ env: z.string() }),
      needsApproval: true,
      execute: ({ env }) => (runs.push(env), `deployed to ${env}`),
    });
    const model = mockModel(turns);
    const server = deployed(createAgent({ provider: model, instructions: 'remote', tools: [deploy] }));
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

  it('is decided from a fresh lead agent on the same SQLite store, without the token being stored', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loushy-y73-'));
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
    expect(errorMessage(result.messages)).toContain('LOUSHY_REMOTE_UNAUTHORIZED');
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
    expect(errorMessage(result.messages)).toContain('LOUSHY_REMOTE_REQUEST_FAILED');
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
