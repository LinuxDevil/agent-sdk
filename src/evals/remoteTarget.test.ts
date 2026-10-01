import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { serveFetch } from '../server/fetchRoutes';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockTurn } from '../testing';
import { renderJunit } from '../cli/evalReport';
import { SDKError } from '../execution/errors';
import { remoteTarget, remoteTargetFromEnv } from './remoteTarget';
import { runTrajectoryCase, type EvalTestContext } from './trajectory';

const TOKEN = 'secret-deploy-token';

const lookupOrder = defineTool({
  name: 'lookup_order',
  description: 'Look up an order',
  input: z.object({ orderId: z.string() }),
  execute: ({ orderId }) => ({ orderId, status: 'shipped' }),
});

const SCRIPT: MockTurn[] = [
  { toolCalls: [{ name: 'lookup_order', args: { orderId: '42' } }], usage: { inputTokens: 10, outputTokens: 5 } },
  { text: 'Order 42 has shipped.', usage: { inputTokens: 10, outputTokens: 5 } },
];

/** The "deployment": the real fetch routes serving a mockModel agent, called without a socket. */
function deployment(script: MockTurn[] = SCRIPT): typeof fetch {
  const agent = createAgent({ provider: mockModel(script), tools: [lookupOrder] });
  return (input, init) => serveFetch(new Request(input as string, init), { name: 'test', agent: () => agent }, TOKEN);
}

const target = (fetchImpl: typeof fetch, auth: string | undefined = TOKEN) => remoteTarget({ url: 'https://agent.test/', auth, fetch: fetchImpl });

const run = (agent: ReturnType<typeof remoteTarget>, test: (t: EvalTestContext) => void | Promise<void>) =>
  runTrajectoryCase({ name: 'remote refund', agent, test }, undefined, 'case 1', undefined);

describe('remoteTarget (LOU-D47)', () => {
  it('passes a case: tool call, reply, usage and steps come from the stream', async () => {
    const result = await run(target(deployment()), async (t) => {
      await t.send('Where is order 42?');
      t.completed();
      t.calledTool('lookup_order', { args: { orderId: '42' } });
      t.maxSteps(2);
      t.maxTokens(100);
      expect(t.reply).toBe('Order 42 has shipped.');
    });
    expect(result.error).toBeUndefined();
    expect(result.passed).toBe(true);
    expect(result.steps).toBe(2);
    expect(result.toolCalls).toEqual([{ name: 'lookup_order', args: { orderId: '42' } }]);
    expect(result.usage?.totalTokens).toBe(30);
  });

  it('fails a case whose trajectory check does not hold, and JUnit shows it', async () => {
    const results = await Promise.all([
      run(target(deployment()), async (t) => {
        await t.send('hi');
        t.calledTool('lookup_order');
      }),
      run(target(deployment([{ text: 'No tools here.' }])), async (t) => {
        await t.send('hi');
        t.calledTool('lookup_order');
      }),
    ]);
    expect(results.map((r) => r.passed)).toEqual([true, false]);
    const xml = renderJunit(results, false);
    expect(xml).toContain('tests="2"');
    expect(xml).toContain("<failure message=\"calledTool('lookup_order') failed: tools called were none\"");
  });

  it('uses one remote session per case, shared by its sends', async () => {
    const sessions: string[] = [];
    const inner = deployment([{ text: 'one' }, { text: 'two' }]);
    const spy: typeof fetch = (input, init) => {
      sessions.push((JSON.parse(String(init?.body)) as { sessionId: string }).sessionId);
      return inner(input, init);
    };
    await run(target(spy), async (t) => {
      await t.send('a');
      await t.send('b');
    });
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toBe(sessions[1]);
    expect(sessions[0]).toMatch(/^eval-/);
  });

  it('fails the case with a coded error on 401, without leaking a token', async () => {
    const result = await run(target(deployment(), 'wrong-token-value'), async (t) => {
      await t.send('hi');
    });
    expect(result.passed).toBe(false);
    expect(result.error).toContain('LOUSHY_REMOTE_UNAUTHORIZED');
    expect(JSON.stringify(result)).not.toContain('wrong-token-value');
    expect(renderJunit([result], false)).not.toContain('wrong-token-value');
  });

  it('turns network errors, non-2xx and truncated streams into coded SDK errors', async () => {
    const send = (fetchImpl: typeof fetch) => target(fetchImpl)().send('hi');
    const down = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(send(down)).rejects.toMatchObject({ code: 'LOUSHY_REMOTE_REQUEST_FAILED', message: expect.stringContaining('ECONNREFUSED') });
    await expect(send(async () => new Response('boom', { status: 502 }))).rejects.toThrow(/502/);
    const truncated = async () => new Response('data: {"type":"run.start","runId":"r","seq":0,"v":1,"timestamp":"t","agentName":"a"}\n\n');
    const error = await send(truncated).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SDKError);
    expect((error as SDKError).code).toBe('LOUSHY_REMOTE_REQUEST_FAILED');
    expect((error as SDKError).message).toContain('without a run.done');
  });

  it('names what a stream does not carry instead of passing token checks silently', async () => {
    const noUsage = async () =>
      new Response(
        ['step.start', 'run.done']
          .map((type, seq) => `data: ${JSON.stringify({ type, runId: 'r', seq, v: 1, timestamp: 't', step: 1, finishReason: 'stop', text: 'ok' })}\n\n`)
          .join('')
      );
    const result = await run(target(noUsage), async (t) => {
      await t.send('hi');
      t.completed();
      t.maxTokens(10);
    });
    expect(result.passed).toBe(false);
    expect(result.assertions.find((a) => a.name === 'maxTokens(10)')?.message).toContain('the remote stream carried no usage');
  });

  it('remoteTargetFromEnv reads the URL and token the CLI passes on', () => {
    expect(remoteTargetFromEnv({})).toBeUndefined();
    expect(remoteTargetFromEnv({ LOUSHY_EVAL_URL: 'https://x.test', LOUSHY_EVAL_TOKEN: 't' })).toBeTypeOf('function');
  });
});
