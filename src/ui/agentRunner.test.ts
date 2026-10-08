/**
 * LOU-D32.2: approve() / reject() / answer() of the runner consume the streamed
 * continuation event by event, and fall back to an older server's JSON outcome.
 */
import { describe, it, expect } from 'vitest';
import { createAgentRunner } from './agentRunner';
import { AGENT_EVENT_SCHEMA_VERSION } from '../execution/agentEvents';
import { initialAgentUIState, reduceAgentEvents, type AgentUIState } from './reducer';

const base = { runId: 'r1', timestamp: new Date(0).toISOString(), v: AGENT_EVENT_SCHEMA_VERSION };
const frame = (event: Record<string, unknown>) => new TextEncoder().encode(`data: ${JSON.stringify({ ...base, seq: 0, ...event })}\n\n`);
const pause = (approvalId: string, toolCallId: string) => [
  frame({ type: 'approval.requested', approvalId, toolCallId, toolName: 'pay', args: {} }),
  frame({ type: 'run.done', finishReason: 'awaiting-approval', text: '' }),
];

/** A runner whose server pauses on `send`, then streams the continuation by hand (chunks pushed through `push`). */
function harness(continuation: 'sse' | 'json') {
  let state: AgentUIState = initialAgentUIState;
  let push!: (chunk: Uint8Array) => void;
  let close!: () => void;
  const fetchMock = (async (url: string | URL | Request) => {
    if (String(url) === '/send') return new Response(new Blob(pause('ap1', 'c1') as BlobPart[]), { headers: { 'Content-Type': 'text/event-stream' } });
    if (continuation === 'json') return Response.json({ text: 'Paid.', finishReason: 'stop' });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk) => controller.enqueue(chunk);
        close = () => controller.close();
      },
    });
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
  const runner = createAgentRunner({
    source: () => ({ url: '/send', fetch: fetchMock }),
    options: () => ({ approvalsUrl: '/approvals' }),
    state: () => state,
    dispatch: (action) => (state = reduceAgentEvents(state, action)),
  });
  return { runner, state: () => state, push: (chunk: Uint8Array) => push(chunk), close: () => close() };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('createAgentRunner approvals over the session API (LOU-D32.2)', () => {
  it('shows the streamed continuation as it arrives, then a second pause like a first one', async () => {
    const h = harness('sse');
    await h.runner.send('Pay');
    expect(h.state().pendingApproval?.id).toBe('ap1');

    const approving = h.runner.approve();
    await tick();
    h.push(frame({ type: 'tool.done', toolCallId: 'c1', toolName: 'pay', durationMs: 1, result: 'ok' }));
    h.push(frame({ type: 'text.delta', text: 'Paid, ' }));
    await tick();
    expect(h.state().status).toBe('streaming');
    expect(h.state().messages[1]).toMatchObject({ text: 'Paid, ', toolCalls: [{ id: 'c1', status: 'done' }] });

    for (const chunk of pause('ap2', 'c2')) h.push(chunk);
    h.close();
    await approving;
    expect(h.state()).toMatchObject({ status: 'awaiting-approval', pendingApproval: { id: 'ap2', toolCallId: 'c2' } });
  });

  it('falls back to the ApprovalOutcome JSON of an older server', async () => {
    const h = harness('json');
    await h.runner.send('Pay');
    await h.runner.approve();
    expect(h.state()).toMatchObject({ status: 'idle', pendingApproval: null });
    expect(h.state().messages[1].text).toBe('Paid.');
  });
});

describe('remote mode session id (Eve CORE-F1)', () => {
  function remote(source: { sessionId?: string } = {}) {
    const bodies: Array<{ input: string; sessionId?: string }> = [];
    const fetchMock = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response('', { headers: { 'Content-Type': 'text/event-stream' } });
    }) as typeof fetch;
    let state: AgentUIState = initialAgentUIState;
    const runner = createAgentRunner({
      source: () => ({ url: '/send', fetch: fetchMock, ...source }),
      options: () => ({}),
      state: () => state,
      dispatch: (action) => (state = reduceAgentEvents(state, action)),
    });
    return { runner, bodies };
  }

  it('sends one generated sessionId for the whole chat and a new one after reset()', async () => {
    const { runner, bodies } = remote();
    await runner.send('a');
    await runner.send('b');
    expect(bodies[0].sessionId).toBeTruthy();
    expect(bodies[1].sessionId).toBe(bodies[0].sessionId);
    runner.reset();
    await runner.send('c');
    expect(bodies[2].sessionId).toBeTruthy();
    expect(bodies[2].sessionId).not.toBe(bodies[0].sessionId);
  });

  it('sends the caller-provided sessionId to resume a session', async () => {
    const { runner, bodies } = remote({ sessionId: 'stored-1' });
    await runner.send('a');
    expect(bodies[0]).toEqual({ input: 'a', sessionId: 'stored-1' });
  });
});
