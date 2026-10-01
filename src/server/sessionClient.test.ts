import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockTurn } from '../testing';
import { SDKError } from '../execution/errors';
import { serveFetch } from './fetchRoutes';
import { runRemoteTurn, type SessionClientOptions } from './sessionClient';

const TOKEN = 'secret-token-123';
type Fetch = typeof fetch;

const echo = defineTool({ name: 'echo', description: 'Echo', input: z.object({ v: z.string() }), execute: ({ v }) => v });
const gated = defineTool({ name: 'deploy', description: 'Deploys', input: z.object({}), needsApproval: true, execute: () => 'ok' });

/** The "deployment": the real fetch routes in front of a mockModel agent, no socket. */
function deployed(script: MockTurn[], token = TOKEN, requests: Request[] = []): Fetch {
  const agent = createAgent({ provider: mockModel(script), instructions: 'remote', tools: [echo, gated] });
  return async (input, init) => {
    const request = new Request(input as string, init);
    requests.push(request.clone());
    return serveFetch(request, { name: 'remote', agent: () => agent }, token);
  };
}

const turn = (extra: Partial<Parameters<typeof runRemoteTurn>[1]> = {}) => ({ sessionId: 's1', input: 'hi', label: 'The remote', ...extra });
const client = (fetchImpl: Fetch, extra: Partial<SessionClientOptions> = {}): SessionClientOptions => ({
  url: 'https://agent.test/',
  auth: TOKEN,
  fetch: fetchImpl,
  ...extra,
});
const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (e: unknown) => e as SDKError);

describe('runRemoteTurn (LOU-D53)', () => {
  it('posts the turn and summarizes the run: text, tool calls, steps, usage, session id', async () => {
    const requests: Request[] = [];
    const script: MockTurn[] = [{ toolCalls: [{ name: 'echo', args: { v: 'x' } }], usage: { inputTokens: 3, outputTokens: 2 } }, { text: 'done', usage: { inputTokens: 3, outputTokens: 2 } }];
    const summary = await runRemoteTurn(client(deployed(script, TOKEN, requests), { headers: { 'X-Team': 'a' } }), turn());

    expect(summary).toMatchObject({ sessionId: 's1', text: 'done', finishReason: 'stop', steps: 2, approval: undefined, error: undefined });
    expect(summary.toolCalls.map((c) => [c.function.name, c.function.arguments])).toEqual([['echo', '{"v":"x"}']]);
    expect(summary.usage?.totalTokens).toBe(10);
    const [request] = requests;
    expect(request.url).toBe('https://agent.test/chat');
    expect(request.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(request.headers.get('x-team')).toBe('a');
    expect(await request.json()).toEqual({ sessionId: 's1', input: 'hi' });
  });

  it('accepts a token function', async () => {
    const summary = await runRemoteTurn(client(deployed(['ok']), { auth: async () => TOKEN }), turn());
    expect(summary.text).toBe('ok');
  });

  it('throws LOUSHY_REMOTE_UNAUTHORIZED on 401', async () => {
    const error = await failure(runRemoteTurn(client(deployed(['x'], 'other-token')), turn()));
    expect(error).toBeInstanceOf(SDKError);
    expect(error?.code).toBe('LOUSHY_REMOTE_UNAUTHORIZED');
    expect(error?.message).toContain('The remote');
    expect(error?.message).toContain('401');
  });

  it('throws LOUSHY_REMOTE_REQUEST_FAILED on a non-2xx answer, with the server detail', async () => {
    const error = await failure(runRemoteTurn(client(async () => Response.json({ error: 'boom' }, { status: 502 })), turn()));
    expect(error?.code).toBe('LOUSHY_REMOTE_REQUEST_FAILED');
    expect(error?.message).toContain('answered 502: boom');
  });

  it('throws LOUSHY_REMOTE_REQUEST_FAILED on a network error', async () => {
    const down: Fetch = async () => {
      throw new TypeError('ECONNREFUSED');
    };
    const error = await failure(runRemoteTurn(client(down), turn()));
    expect(error?.code).toBe('LOUSHY_REMOTE_REQUEST_FAILED');
    expect(error?.message).toContain('could not be reached at https://agent.test/chat: ECONNREFUSED');
  });

  it('throws on a truncated or foreign stream, and when the stream breaks', async () => {
    const start = 'data: {"type":"run.start","runId":"r","seq":0,"v":1,"timestamp":"t","agentName":"a"}\n\n';
    for (const body of [start, 'hello']) {
      const error = await failure(runRemoteTurn(client(async () => new Response(body)), turn()));
      expect(error?.code).toBe('LOUSHY_REMOTE_REQUEST_FAILED');
      expect(error?.message).toContain('without a run.done');
    }
    const broken = new ReadableStream<Uint8Array>({ start: (c) => c.error(new Error('socket hang up')) });
    const error = await failure(runRemoteTurn(client(async () => new Response(broken)), turn()));
    expect(error?.code).toBe('LOUSHY_REMOTE_REQUEST_FAILED');
    expect(error?.message).toContain('stream failed: socket hang up');
  });

  it('aborts the in-flight request', async () => {
    const hanging: Fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const controller = new AbortController();
    const run = failure(runRemoteTurn(client(hanging), turn({ signal: controller.signal })));
    controller.abort();
    const error = await run;
    expect(error?.code).toBe('LOUSHY_REMOTE_REQUEST_FAILED');
    expect(error?.message).toContain('was aborted');
  });

  it('never lets the token reach an error message', async () => {
    const leaky: Fetch = async () => {
      throw new TypeError(`connect failed while sending ${TOKEN}`);
    };
    const network = await failure(runRemoteTurn(client(leaky), turn({ label: `The remote ${TOKEN}` })));
    const status = await failure(runRemoteTurn(client(async () => Response.json({ error: `bad ${TOKEN}` }, { status: 500 })), turn()));
    const stream = new ReadableStream<Uint8Array>({ start: (c) => c.error(new Error(`broke ${TOKEN}`)) });
    const broken = await failure(runRemoteTurn(client(async () => new Response(stream)), turn()));
    for (const error of [network, status, broken]) {
      expect(error?.message).toContain('[redacted]');
      expect(error?.message).not.toContain(TOKEN);
    }
  });

  it('summarizes a run that paused for approval, with the pending tool call', async () => {
    const summary = await runRemoteTurn(client(deployed([{ toolCalls: [{ name: 'deploy' }] }, 'never'])), turn());
    expect(summary.finishReason).toBe('awaiting-approval');
    expect(summary.approval).toMatchObject({ toolName: 'deploy', args: {} });
    expect(summary.approval?.approvalId).toEqual(expect.any(String));
  });

  it('summarizes a remote run that ended in an error instead of throwing', async () => {
    const summary = await runRemoteTurn(client(deployed([{ error: new Error('model exploded') }])), turn());
    expect(summary.finishReason).toBe('error');
    expect(summary.error).toContain('model exploded');
  });
});
