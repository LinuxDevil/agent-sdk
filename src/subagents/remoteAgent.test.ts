import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent, type SimpleAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockTurn } from '../testing';
import { serveFetch } from '../server/fetchRoutes';
import type { Message } from '../providers';
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

    expect(String(toolResult(result.messages))).toMatch(/^The answer is 42\.\n\n\[remote sub-agent 'remote': session 'task_[\w-]+', finish reason 'stop'\]$/);
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

  it('says when the remote agent awaits approval, with its session id', async () => {
    const deploy = defineTool({ name: 'deploy', description: 'Deploys', input: z.object({}), needsApproval: true, execute: () => 'deployed' });
    const remoteModel = mockModel([{ toolCalls: [{ name: 'deploy' }] }, 'never']);
    const server = deployed(createAgent({ provider: remoteModel, instructions: 'remote', tools: [deploy] }));
    const { agent } = lead(remoteAgent({ url: 'https://remote.test', auth: TOKEN, fetch: server.fetch }));
    const message = errorMessage((await agent.send('go')).messages);
    expect(message).toContain('awaiting approval');
    expect(message).toMatch(/session 'task_[\w-]+'/);
    expect(message).toContain('LOUSHY_SESSION_AWAITING_APPROVAL');
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
