import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockTurn } from '../testing';
import type { Message } from '../providers';
import { subagentOptionsOf, withSubagentOptions } from './backgroundTasks';
import { AgentExecutor, type ExecutionEvent } from '../execution/AgentExecutor';
import type { AgentConfig } from '../types';

const bgTask = (agent: string, prompt: string) => ({
  name: 'task',
  args: { agent, prompt, description: `${agent} task`, background: true },
});

/** The parsed results of the lead's tool calls named `name`, in order. */
function results(messages: readonly Message[], name: string): Record<string, unknown>[] {
  return messages
    .filter((m) => m.role === 'tool' && m.toolName === name)
    .map((m) => JSON.parse(m.content as string) as Record<string, unknown>);
}

/** A child tool that blocks until `release()` or until its run is aborted. */
function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => (release = resolve));
  let onAbort!: () => void;
  const aborted = new Promise<void>((resolve) => (onAbort = resolve));
  let onEnter!: () => void;
  const entered = new Promise<void>((resolve) => (onEnter = resolve));
  const tool = defineTool({
    name: 'wait',
    description: 'Waits',
    input: z.object({}),
    execute: (_args, ctx) =>
      new Promise<string>((resolve, reject) => {
        onEnter();
        void opened.then(() => resolve('waited'));
        ctx.abortSignal?.addEventListener('abort', () => {
          onAbort();
          reject(new Error('aborted'));
        });
      }),
  });
  return { tool, release, aborted, entered };
}

/** A sub-agent that calls `wait` once, then answers with `answer` (`#n` for its n-th run). */
function waitingChild(tool: ReturnType<typeof gate>['tool'], answer = 'answer') {
  let runs = 0;
  const turn: MockTurn = (req) =>
    req.messages.at(-1)?.role === 'tool' ? `${answer} #${runs}` : (runs++, { toolCalls: [{ name: 'wait' }] });
  return createAgent({ provider: mockModel([turn], { onExhausted: 'repeat-last' }), tools: [tool], description: 'Researches' });
}

describe('background sub-agents (LOU-Y4)', () => {
  it('returns a taskId at once; agent_status and agent_await report the answer', async () => {
    const { tool, release } = gate();
    const researcher = waitingChild(tool, 'Paris');
    const leadModel = mockModel([
      { toolCalls: [bgTask('researcher', 'capital of France?')] },
      { toolCalls: [{ name: 'agent_status', args: {} }] },
      () => (release(), { toolCalls: [{ name: 'agent_await', args: { taskId: 'task_1' } }] }),
      'done',
    ]);
    const lead = createAgent({ provider: leadModel, subagents: { researcher } });

    const result = await lead.send('go');

    expect(results(result.messages, 'task')).toEqual([{ taskId: 'task_1', status: 'running', agent: 'researcher' }]);
    const [status] = results(result.messages, 'agent_status');
    expect(status.tasks).toEqual([{ taskId: 'task_1', agent: 'researcher', status: 'running', elapsedMs: expect.any(Number) }]);
    expect(results(result.messages, 'agent_await')[0]).toMatchObject({
      taskId: 'task_1',
      status: 'done',
      result: "Paris #1\n\n[sub-agent 'researcher': 2 step(s), finish reason 'stop', taskId 'task_1']",
    });
    expect(leadModel.calls[0].tools?.map((t) => t.function.name)).toEqual(['task', 'agent_status', 'agent_await', 'agent_cancel']);
    expect(result.text).toBe('done');
  });

  it('queues tasks beyond maxConcurrent and starts them as slots free', async () => {
    const { tool, release } = gate();
    const researcher = waitingChild(tool);
    const leadModel = mockModel([
      { toolCalls: [bgTask('researcher', 'a'), bgTask('researcher', 'b')] },
      { toolCalls: [{ name: 'agent_status', args: {} }] },
      () => (release(), { toolCalls: [{ name: 'agent_await', args: { taskIds: ['task_1', 'task_2'] } }] }),
      'done',
    ]);
    const lead = createAgent({ provider: leadModel, subagents: withSubagentOptions({ researcher }, { maxConcurrent: 1 }) });

    const result = await lead.send('go');

    expect(results(result.messages, 'task').map((r) => r.status)).toEqual(['running', 'queued']);
    const [status] = results(result.messages, 'agent_status');
    expect((status.tasks as { status: string }[]).map((t) => t.status)).toEqual(['running', 'queued']);
    const [awaited] = results(result.messages, 'agent_await');
    expect((awaited.tasks as { status: string; result: string }[]).map((t) => [t.status, t.result.split('\n')[0]])).toEqual([
      ['done', 'answer #1'],
      ['done', 'answer #2'],
    ]);
  });

  it('agent_await times out on a running task, and agent_cancel stops it', async () => {
    const { tool, aborted } = gate();
    const lead = createAgent({
      provider: mockModel([
        { toolCalls: [bgTask('researcher', 'a')] },
        { toolCalls: [{ name: 'agent_await', args: { taskId: 'task_1', timeoutMs: 5 } }] },
        { toolCalls: [{ name: 'agent_cancel', args: { taskId: 'task_1' } }] },
        { toolCalls: [{ name: 'agent_await', args: { taskId: 'task_1' } }] },
        'done',
      ]),
      subagents: { researcher: waitingChild(tool) },
    });

    const result = await lead.send('go');

    expect(results(result.messages, 'agent_await').map((r) => r.status)).toEqual(['timeout', 'cancelled']);
    expect(results(result.messages, 'agent_cancel')[0]).toMatchObject({ taskId: 'task_1', status: 'cancelled' });
    await aborted;
  });

  it('aborting the lead cancels its background sub-agents', async () => {
    const { tool, aborted, entered } = gate();
    const controller = new AbortController();
    const abortOnceRunning = async () => {
      await entered;
      controller.abort();
      return 'stopping';
    };
    const lead = createAgent({
      provider: mockModel([{ toolCalls: [bgTask('researcher', 'a')] }, abortOnceRunning]),
      subagents: { researcher: waitingChild(tool) },
    });

    await lead.send('go', { signal: controller.signal });

    // The child's in-flight tool call sees the abort (the test times out otherwise).
    await aborted;
  });

  it('reports a sub-agent paused for approval as awaiting-approval, with its approvalId (without agent_await, M4)', async () => {
    let ran = false;
    let asked!: () => void;
    const approvalAsked = new Promise<void>((resolve) => (asked = resolve));
    const needsApproval = () => (asked(), true);
    const deploy = defineTool({ name: 'deploy', description: 'Deploys', input: z.object({}), needsApproval, execute: () => (ran = true) });
    const researcher = createAgent({ provider: mockModel([{ toolCalls: [{ name: 'deploy' }] }]), tools: [deploy], description: 'Deploys' });
    // The child's pause settles in microtasks once its approval is asked for.
    const statusOncePaused = async (): Promise<MockTurn> => {
      await approvalAsked;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { toolCalls: [{ name: 'agent_status', args: { taskId: 'task_1' } }] };
    };
    const lead = createAgent({
      provider: mockModel([{ toolCalls: [bgTask('researcher', 'ship it')] }, statusOncePaused, 'done']),
      subagents: { researcher },
    });

    const result = await lead.send('go');

    const [status] = results(result.messages, 'agent_status');
    expect(status.tasks).toEqual([expect.objectContaining({ status: 'awaiting-approval', toolName: 'deploy', approvalId: expect.any(String) })]);
    expect(ran).toBe(false);
    expect(result.finishReason).toBe('stop');
    expect(result.text).toBe('done');
    // Never awaited: reported at the end, and not resumable (no approval of the lead).
    expect(result.backgroundTasks).toEqual([expect.objectContaining({ status: 'awaiting-approval' })]);
    expect(await lead.approvals.list()).toEqual([]);
  });

  it('still applies maxSubagentDepth to background sub-agents', async () => {
    const researcherModel = mockModel(['researched']);
    const researcher = createAgent({
      provider: researcherModel,
      description: 'Researches',
      subagents: { deeper: createAgent({ provider: mockModel(['x']), description: 'Deeper' }) },
    });
    const lead = createAgent({
      provider: mockModel([
        { toolCalls: [bgTask('researcher', 'a')] },
        { toolCalls: [{ name: 'agent_await', args: { taskId: 'task_1' } }] },
        'done',
      ]),
      subagents: { researcher },
    });

    const result = await lead.send('go');

    expect(researcherModel.calls[0].tools).toBeUndefined();
    expect(results(result.messages, 'agent_await')[0]).toMatchObject({ status: 'done' });
  });

  it('reports unknown task ids and bad options', async () => {
    const lead = createAgent({
      provider: mockModel([{ toolCalls: [{ name: 'agent_cancel', args: { taskId: 'task_9' } }] }, 'ok']),
      subagents: { researcher: createAgent({ provider: mockModel([]), description: 'Researches' }) },
    });
    const [message] = (await lead.send('go')).messages.filter((m) => m.role === 'tool');
    expect(message.isError).toBe(true);
    expect(message.content).toContain("Unknown background task 'task_9'");
    expect(() => withSubagentOptions({}, { maxConcurrent: 0 })).toThrow(/maxConcurrent/);
  });
});

describe('background sub-agents at the end of the lead run (LOU-Y4.2)', () => {
  const statuses = (tasks: readonly { status: string }[] | undefined) => tasks?.map((t) => t.status);

  it('cancels queued and running background sub-agents when the lead finishes, before the run resolves', async () => {
    const { tool, aborted, entered } = gate();
    const events: ExecutionEvent[] = [];
    const agent: AgentConfig = { id: 'lead', name: 'Lead', prompt: 'p' };
    const finishOnceRunning = async () => (await entered, 'done');
    const result = await AgentExecutor.execute({
      agent,
      input: 'go',
      provider: mockModel([{ toolCalls: [bgTask('researcher', 'a'), bgTask('researcher', 'b')] }, finishOnceRunning]),
      subagents: withSubagentOptions({ researcher: waitingChild(tool) }, { maxConcurrent: 1 }),
      onEvent: (event) => events.push(event),
    });

    expect(result.text).toBe('done');
    expect(result.backgroundTasks).toEqual([
      { taskId: 'task_1', agent: 'researcher', status: 'cancelled', elapsedMs: expect.any(Number) },
      { taskId: 'task_2', agent: 'researcher', status: 'cancelled', elapsedMs: expect.any(Number) },
    ]);
    await aborted;
    // The running child has wound down by then: its last event came before the run resolved.
    expect(events.some((e) => e.type === 'finish' && e.subagent?.name === 'researcher')).toBe(true);
    const seen = events.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toHaveLength(seen);
  });

  it('awaitBackgroundOnFinish waits for them and reports their final statuses', async () => {
    const { tool, release } = gate();
    const lead = createAgent({
      provider: mockModel([{ toolCalls: [bgTask('researcher', 'a')] }, () => (setTimeout(release, 5), 'done')]),
      subagents: { researcher: waitingChild(tool) },
      subagentOptions: { awaitBackgroundOnFinish: true },
    });

    const result = await lead.send('go');

    expect(result.text).toBe('done');
    expect(result.backgroundTasks).toEqual([{ taskId: 'task_1', agent: 'researcher', status: 'done', elapsedMs: expect.any(Number) }]);
  });

  it('createAgent({ subagentOptions }) is forwarded over withSubagentOptions(), without changing the subagents value', async () => {
    const { tool, release } = gate();
    const subagents = withSubagentOptions({ researcher: waitingChild(tool) }, { maxConcurrent: 3, awaitBackgroundOnFinish: true });
    const lead = createAgent({
      provider: mockModel([{ toolCalls: [bgTask('researcher', 'a'), bgTask('researcher', 'b')] }, () => (release(), 'done')]),
      subagents,
      subagentOptions: { maxConcurrent: 1 },
    });

    const result = await lead.send('go');

    expect(results(result.messages, 'task').map((r) => r.status)).toEqual(['running', 'queued']);
    expect(statuses(result.backgroundTasks)).toEqual(['done', 'done']);
    expect(subagentOptionsOf(subagents)).toEqual({ maxConcurrent: 3, awaitBackgroundOnFinish: true });
  });

  it('cancels them when the lead run fails, even with awaitBackgroundOnFinish', async () => {
    const { tool, aborted, entered } = gate();
    const lead = createAgent({
      provider: mockModel([{ toolCalls: [bgTask('researcher', 'a')] }, async () => (await entered, { error: new Error('model down') })]),
      subagents: { researcher: waitingChild(tool) },
      subagentOptions: { awaitBackgroundOnFinish: true },
    });

    await expect(lead.send('go')).rejects.toThrow('model down');
    await aborted;
  });

  it('cancels them when the lead pauses for approval', async () => {
    const { tool, aborted, entered } = gate();
    const deploy = defineTool({ name: 'deploy', description: 'Deploys', input: z.object({}), needsApproval: true, execute: () => 'deployed' });
    const lead = createAgent({
      provider: mockModel([{ toolCalls: [bgTask('researcher', 'a')] }, async () => (await entered, { toolCalls: [{ name: 'deploy' }] })]),
      tools: [deploy],
      subagents: { researcher: waitingChild(tool) },
    });

    const result = await lead.send('go');

    expect(result.finishReason).toBe('awaiting-approval');
    expect(statuses(result.backgroundTasks)).toEqual(['cancelled']);
    await aborted;
  });
});
