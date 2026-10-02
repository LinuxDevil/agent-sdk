/**
 * N5b: `runInParallel` input guardrails check the new input while the first
 * model call is already in flight. The call's output is held until every
 * parallel check passes; a trip cancels the call and nothing it produced is
 * shown, run, checkpointed or kept.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createAgent } from '../createAgent';
import { defineTool } from '../tools/defineTool';
import { mockModel, type MockTurn } from '../testing';
import type { GenerateOptions, GenerateResult, LLMProvider, StreamChunk, StreamResult } from '../providers';
import type { AgentEvent } from './agentEvents';
import type { Checkpoint, CheckpointStore } from './checkpoint';
import { PropagatingToolError } from './AgentExecutor';
import { moderationGuardrail, promptInjectionGuardrail } from './guardrailStarterSet';
import { GuardrailError, PARALLEL_REWRITE_PREFIX, regexGuardrail, type IoGuardrail, type IoGuardrailContext, type IoGuardrailResult } from './ioGuardrails';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A `runInParallel` guardrail whose check resolves when the test says so. */
function gatedGuardrail(name = 'gated') {
  const verdict = deferred<IoGuardrailResult>();
  const seen: IoGuardrailContext[] = [];
  const guardrail: IoGuardrail = {
    name,
    runInParallel: true,
    check: (ctx) => {
      seen.push(ctx);
      return verdict.promise;
    },
  };
  return { guardrail, seen, pass: () => verdict.resolve({ ok: true }), block: (reason = 'blocked') => verdict.resolve({ ok: false, reason }), verdict };
}

/** A model turn that waits for `until` (or the call's abort) before answering `turn`. */
function waitingTurn(until: Promise<unknown>, turn: Exclude<MockTurn, (...args: never[]) => unknown>): MockTurn {
  return async (request) => {
    await Promise.race([
      until,
      new Promise((resolve) => (request.signal as AbortSignal | undefined)?.addEventListener('abort', resolve, { once: true })),
    ]);
    return turn;
  };
}

/** A streaming provider whose chunks the test releases one at a time. */
function steppedModel() {
  const requests: GenerateOptions[] = [];
  const queue: Array<Deferred<StreamChunk | undefined>> = [deferred()];
  let next = 0;
  const push = (chunk: StreamChunk | undefined) => {
    queue.push(deferred());
    queue[queue.length - 2].resolve(chunk);
  };
  const provider: LLMProvider = {
    name: 'stepped',
    defaultModel: 'stepped-model',
    async generate(): Promise<GenerateResult> {
      throw new Error('stream only');
    },
    async stream(request): Promise<StreamResult> {
      requests.push(request);
      const fullStream = async function* (): AsyncGenerator<StreamChunk> {
        for (;;) {
          const chunk = await queue[next++].promise;
          if (!chunk) return;
          yield chunk;
        }
      };
      return {
        fullStream: fullStream(),
        textStream: (async function* () {})(),
        text: Promise.resolve(''),
        usage: Promise.resolve(undefined),
        finishReason: Promise.resolve('stop'),
        toolCalls: Promise.resolve([]),
      } as unknown as StreamResult;
    },
    supportsTools: () => true,
    supportsStreaming: () => true,
    getModels: async () => ['stepped-model'],
  } as LLMProvider;
  return { provider, requests, push };
}

/** Collects a run's events as they arrive, so a test can look at them mid-run. */
function record(run: AsyncIterable<AgentEvent>) {
  const events: AgentEvent[] = [];
  const done = (async () => {
    for await (const event of run) events.push(event);
  })();
  return { events, done };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) await tick();
  expect(predicate()).toBe(true);
}

/** The parts of an event stream that do not depend on ids or timing. */
function shape(events: AgentEvent[]): unknown[] {
  return events.map(({ runId: _runId, seq: _seq, timestamp: _timestamp, ...rest }) => {
    const { durationMs: _durationMs, agentId: _agentId, ...stable } = rest as Record<string, unknown>;
    return stable;
  });
}

function weatherTool() {
  const runs: string[] = [];
  const tool = defineTool({
    name: 'get_weather',
    description: 'Weather for a city',
    input: z.object({ city: z.string() }),
    execute: ({ city }) => {
      runs.push(city);
      return { tempC: 21 };
    },
  });
  return { tool, runs };
}

function memoryStore() {
  const saved: Checkpoint[] = [];
  const store: CheckpointStore = {
    async save(_sessionId, checkpoint) {
      saved.push(JSON.parse(JSON.stringify(checkpoint)) as Checkpoint);
    },
    async load() {
      return saved.at(-1) ?? null;
    },
    async delete() {},
  };
  return { store, saved };
}

describe('runInParallel input guardrails (N5b): a passing check', () => {
  it('starts the model call before the check resolves', async () => {
    const gate = gatedGuardrail();
    const model = mockModel(['Hello there.']);
    const agent = createAgent({ provider: model, guardrails: { input: [gate.guardrail] } });

    const result = agent.send('hi');
    await until(() => model.calls.length === 1);
    expect(gate.seen).toHaveLength(1); // both are running now

    gate.pass();
    expect((await result).text).toBe('Hello there.');
  });

  it('holds the streamed deltas until the check passes, then releases them in order; the run matches a blocking one', async () => {
    const reply = 'It is sunny in Paris today.';
    const blockingRun = await (async () => {
      const blocking: IoGuardrail = { name: 'gated', check: () => ({ ok: true }) };
      const agent = createAgent({ provider: mockModel([reply]), guardrails: { input: [blocking] } });
      const run = record(agent.stream('weather?'));
      await run.done;
      return run.events;
    })();

    const gate = gatedGuardrail();
    const model = mockModel([reply]);
    const agent = createAgent({ provider: model, guardrails: { input: [gate.guardrail] } });
    const stream = agent.stream('weather?');
    const run = record(stream);
    await until(() => model.calls.length === 1);
    await tick();
    expect(run.events.map((e) => e.type)).toEqual(['run.start', 'step.start']);

    gate.pass();
    await run.done;
    const deltas = run.events.filter((e) => e.type === 'text.delta').map((e) => (e as { text: string }).text);
    expect(deltas.join('')).toBe(reply);
    expect(deltas.length).toBeGreaterThan(1);
    expect(shape(run.events)).toEqual(shape(blockingRun));
    expect((await stream.result).finishReason).toBe('stop');
  });

  it('releases what was held mid-stream, then streams the rest as it arrives', async () => {
    const gate = gatedGuardrail();
    const { provider, push } = steppedModel();
    const agent = createAgent({ provider, guardrails: { input: [gate.guardrail] } });
    const stream = agent.stream('hi');
    const run = record(stream);
    const deltas = () => run.events.filter((e) => e.type === 'text.delta').map((e) => (e as { text: string }).text);

    push({ type: 'text-delta', textDelta: 'one ' });
    push({ type: 'text-delta', textDelta: 'two ' });
    await tick();
    await tick();
    expect(deltas()).toEqual([]);

    gate.pass();
    await until(() => deltas().length === 2);
    expect(deltas()).toEqual(['one ', 'two ']);

    push({ type: 'text-delta', textDelta: 'three' });
    await until(() => deltas().length === 3);
    push({ type: 'finish', finishReason: 'stop' });
    push(undefined);
    await run.done;
    expect(deltas()).toEqual(['one ', 'two ', 'three']);
    const types = run.events.map((e) => e.type);
    expect(types.indexOf('text.done')).toBeGreaterThan(types.lastIndexOf('text.delta'));
    expect((await stream.result).text).toBe('one two three');
  });

  it('a model that finishes first waits for the check before its tool calls run', async () => {
    const gate = gatedGuardrail();
    const { tool, runs } = weatherTool();
    const model = mockModel([{ toolCalls: [{ name: 'get_weather', args: { city: 'Paris' } }] }, 'Sunny.']);
    const agent = createAgent({ provider: model, tools: [tool], guardrails: { input: [gate.guardrail] } });

    const result = agent.send('weather in Paris?');
    await until(() => model.calls.length === 1);
    for (let i = 0; i < 5; i++) await tick();
    expect(runs).toEqual([]);

    gate.pass();
    expect((await result).text).toBe('Sunny.');
    expect(runs).toEqual(['Paris']);
    expect(gate.seen).toHaveLength(1); // only the first model call is raced
  });
});

describe('runInParallel input guardrails (N5b): a trip', () => {
  it('aborts the in-flight call; no text, no tool, no usage; ends as a blocking trip would', async () => {
    const gate = gatedGuardrail();
    const { tool, runs } = weatherTool();
    const never = new Promise<never>(() => undefined);
    const model = mockModel([waitingTurn(never, { text: 'leaked', toolCalls: [{ name: 'get_weather', args: { city: 'Paris' } }] })]);
    const agent = createAgent({ provider: model, tools: [tool], guardrails: { input: [gate.guardrail] } });

    const stream = agent.stream('bad input');
    const run = record(stream);
    await until(() => model.calls.length === 1);
    gate.block('nope');
    await run.done;
    const result = await stream.result;

    expect((model.calls[0].signal as AbortSignal).aborted).toBe(true);
    expect(result.finishReason).toBe('guardrail');
    expect(result.guardrail).toEqual({ name: 'gated', kind: 'input', reason: 'nope' });
    expect(result.text).toBe('');
    expect(result.messages.map((m) => m.role).filter((role) => role !== 'system')).toEqual(['user']);
    expect(result.usage.modelCalls).toBe(0);
    expect(runs).toEqual([]);
    const types = run.events.map((e) => e.type);
    expect(types).not.toContain('text.delta');
    expect(types).not.toContain('tool.start');
    expect(types.slice(-3)).toEqual(['guardrail.tripped', 'step.done', 'run.done']);
    expect(run.events.find((e) => e.type === 'step.done')).toMatchObject({ finishReason: 'guardrail' });
  });

  it('drops the deltas it held when it trips mid-stream', async () => {
    const gate = gatedGuardrail();
    const { provider, requests, push } = steppedModel();
    const agent = createAgent({ provider, guardrails: { input: [gate.guardrail] } });
    const stream = agent.stream('hi');
    const run = record(stream);

    push({ type: 'text-delta', textDelta: 'secret ' });
    await until(() => requests.length === 1);
    await tick();
    gate.block();
    push({ type: 'text-delta', textDelta: 'more' });
    push(undefined);
    await run.done;

    expect(requests[0].signal?.aborted).toBe(true);
    expect(run.events.map((e) => e.type)).not.toContain('text.delta');
    expect((await stream.result).finishReason).toBe('guardrail');
  });

  it('discards a reply that came first: no tool runs, no checkpoint holds it; its reported usage counts', async () => {
    const gate = gatedGuardrail();
    const { tool, runs } = weatherTool();
    const { store, saved } = memoryStore();
    const model = mockModel([{ text: 'calling', toolCalls: [{ name: 'get_weather', args: { city: 'Paris' } }], usage: { inputTokens: 12, outputTokens: 3 } }]);
    const agent = createAgent({ provider: model, tools: [tool], store: { checkpoints: store }, guardrails: { input: [gate.guardrail] } });

    const stream = agent.stream('bad', { sessionId: 's1' });
    const run = record(stream);
    const events = run.events;
    await until(() => model.calls.length === 1);
    for (let i = 0; i < 5; i++) await tick();
    expect(saved).toEqual([]);
    gate.block();
    await run.done;
    const done = await stream.result;

    expect(done.finishReason).toBe('guardrail');
    expect(runs).toEqual([]);
    expect(done.toolCalls).toEqual([]);
    expect(done.usage).toMatchObject({ inputTokens: 12, outputTokens: 3, modelCalls: 1, estimated: false });
    expect(saved.every((checkpoint) => checkpoint.messages.every((m) => m.role === 'user' || m.role === 'system'))).toBe(true);
    expect(saved.at(-1)?.status).toBe('finished');
    expect(events.map((e) => e.type)).not.toContain('text.delta');
    expect(events.find((e) => e.type === 'step.done')).toMatchObject({ usage: { inputTokens: 12, estimated: false } });
  });

  it('estimates nothing for a discarded reply without reported usage', async () => {
    const gate = gatedGuardrail();
    const model = mockModel(['no usage reported']);
    const agent = createAgent({ provider: model, guardrails: { input: [gate.guardrail] } });

    const result = agent.send('bad');
    await until(() => model.calls.length === 1);
    await tick();
    gate.block();
    const done = await result;

    expect(done.finishReason).toBe('guardrail');
    expect(done.usage).toMatchObject({ inputTokens: 0, outputTokens: 0, modelCalls: 0 });
  });

  it('wins a race with the model finishing in the same tick', async () => {
    const gate = gatedGuardrail();
    const { tool, runs } = weatherTool();
    const { store, saved } = memoryStore();
    const answer = deferred<void>();
    const model = mockModel([waitingTurn(answer.promise, { toolCalls: [{ name: 'get_weather', args: { city: 'Paris' } }] })]);
    const agent = createAgent({ provider: model, tools: [tool], store: { checkpoints: store }, guardrails: { input: [gate.guardrail] } });

    const result = agent.send('bad', { sessionId: 's1' });
    await until(() => model.calls.length === 1);
    answer.resolve();
    gate.block();
    const done = await result;

    expect(done.finishReason).toBe('guardrail');
    expect(runs).toEqual([]);
    expect(saved.every((checkpoint) => checkpoint.messages.every((m) => m.role === 'user' || m.role === 'system'))).toBe(true);
  });

  it("rejects with GuardrailError under onTripped: 'throw'", async () => {
    const gate = gatedGuardrail();
    const model = mockModel([waitingTurn(new Promise(() => undefined), 'x')]);
    const agent = createAgent({ provider: model, guardrails: { input: [gate.guardrail], onTripped: 'throw' } });

    const result = agent.send('bad').catch((error: unknown) => error);
    await until(() => model.calls.length === 1);
    gate.block('nope');

    const error = await result;
    expect(error).toBeInstanceOf(GuardrailError);
    expect(error).toMatchObject({ code: 'LOUSHO_GUARDRAIL_TRIPPED', guardrail: { name: 'gated', kind: 'input', reason: 'nope' } });
  });

  it('a rewrite from a parallel guardrail blocks, with the reason prefixed', async () => {
    const model = mockModel(['x'], { onExhausted: 'repeat-last' });
    const redact = { ...regexGuardrail({ name: 'ssn', pattern: /\d{3}-\d{2}-\d{4}/, action: 'rewrite' }), runInParallel: true };
    const agent = createAgent({ provider: model, guardrails: { input: [redact] } });

    const result = await agent.send('my ssn is 123-45-6789');

    expect(result.finishReason).toBe('guardrail');
    expect(result.guardrail?.reason.startsWith(PARALLEL_REWRITE_PREFIX)).toBe(true);
    expect(result.text).toBe('');
    expect(result.messages.at(-1)?.content).toBe('my ssn is 123-45-6789'); // never rewritten
  });

  it('a throwing check fails the run and cancels the call', async () => {
    const model = mockModel([waitingTurn(new Promise(() => undefined), 'x')]);
    const failing: IoGuardrail = { name: 'broken', runInParallel: true, check: () => Promise.reject(new Error('classifier down')) };
    const agent = createAgent({ provider: model, guardrails: { input: [failing] } });

    await expect(agent.send('hi')).rejects.toThrow('classifier down');
    expect((model.calls[0].signal as AbortSignal).aborted).toBe(true);
  });

  it('send() (not streamed, no listeners) behaves the same', async () => {
    const gate = gatedGuardrail();
    const model = mockModel([waitingTurn(new Promise(() => undefined), 'leaked')]);
    const agent = createAgent({ provider: model, guardrails: { input: [gate.guardrail] } });

    const result = agent.send('bad');
    await until(() => model.calls.length === 1);
    gate.block();
    const done = await result;

    expect((model.calls[0].signal as AbortSignal).aborted).toBe(true);
    expect(done).toMatchObject({ finishReason: 'guardrail', text: '', guardrail: { name: 'gated' } });
  });
});

describe('runInParallel input guardrails (N5b): with blocking guardrails', () => {
  it('a blocking trip makes no model call and does not start the parallel checks', async () => {
    const gate = gatedGuardrail();
    const model = mockModel(['never']);
    const blocking: IoGuardrail = { name: 'blocking', check: () => ({ ok: false, reason: 'no' }) };
    const agent = createAgent({ provider: model, guardrails: { input: [gate.guardrail, blocking] } });

    const result = await agent.send('hi');

    expect(model.calls).toHaveLength(0);
    expect(gate.seen).toHaveLength(0);
    expect(result.guardrail?.name).toBe('blocking');
  });

  it('the parallel checks see the input the blocking ones rewrote', async () => {
    const gate = gatedGuardrail();
    const model = mockModel(['ok']);
    const agent = createAgent({
      provider: model,
      guardrails: { input: [gate.guardrail, regexGuardrail({ name: 'ssn', pattern: /\d{3}-\d{2}-\d{4}/, action: 'rewrite' })] },
    });

    const result = agent.send('ssn 123-45-6789');
    await until(() => gate.seen.length === 1);
    gate.pass();
    await result;

    expect(gate.seen[0].text).toBe('ssn [redacted]');
    expect(model.calls[0].messages.at(-1)?.content).toBe('ssn [redacted]');
  });

  it('runInParallel is ignored on output and tool guardrails', async () => {
    const model = mockModel(['the answer']);
    const output: IoGuardrail = { name: 'out', runInParallel: true, check: ({ text }) => (text.includes('answer') ? { ok: false, reason: 'no' } : { ok: true }) };
    const agent = createAgent({ provider: model, guardrails: { output: [output] } });

    const result = await agent.send('q');
    expect(result).toMatchObject({ finishReason: 'guardrail', guardrail: { name: 'out', kind: 'output' } });
  });
});

describe('runInParallel input guardrails (N5b): resume and sub-agents', () => {
  it('a run resumed after an approval does not check the input again', async () => {
    let checks = 0;
    const counting: IoGuardrail = { name: 'counting', runInParallel: true, check: () => (checks++, { ok: true }) };
    const deploy = defineTool({ name: 'deploy', description: 'Deploy', input: z.object({}), needsApproval: true, execute: () => 'deployed' });
    const model = mockModel([{ toolCalls: [{ name: 'deploy' }] }, 'done']);
    const agent = createAgent({ provider: model, tools: [deploy], guardrails: { input: [counting] } });

    const paused = await agent.send('deploy');
    expect(paused.finishReason).toBe('awaiting-approval');
    const result = await agent.approvals.resolve({ id: paused.approvalId!, approved: true });

    expect(result.text).toBe('done');
    expect(checks).toBe(1);
  });

  it('a resumed run with new input queued behind pending tool calls runs no tool before the parallel checks pass', async () => {
    let runs = 0;
    const deploy = defineTool({
      name: 'deploy',
      description: 'Deploy',
      input: z.object({}),
      execute: () => {
        runs++;
        if (runs === 1) throw new PropagatingToolError('process died');
        return 'deployed';
      },
    });
    const { store, saved } = memoryStore();
    const model = mockModel([{ toolCalls: [{ name: 'deploy', id: 'd1' }] }, 'never']);
    const crashing = createAgent({ provider: model, tools: [deploy], store: { checkpoints: store } });
    await expect(crashing.send('deploy', { sessionId: 's1' })).rejects.toThrow('process died');
    expect(saved.at(-1)?.status).toBe('in-progress');

    const gate = gatedGuardrail();
    const agent = createAgent({ provider: model, tools: [deploy], store: { checkpoints: store }, guardrails: { input: [gate.guardrail] } });
    const result = agent.send('and also delete prod', { sessionId: 's1' });
    await until(() => gate.seen.length === 1);
    for (let i = 0; i < 5; i++) await tick();
    expect(runs).toBe(1); // the pending call waits for the verdict

    gate.block();
    const done = await result;
    expect(done.finishReason).toBe('guardrail');
    expect(gate.seen[0].text).toBe('and also delete prod');
    expect(runs).toBe(1);
    expect(model.calls).toHaveLength(1);
  });

  it("a sub-agent runs its parent's parallel guardrails on its own input; passing, its text streams", async () => {
    const gate = gatedGuardrail();
    const childModel = mockModel(['child answer']);
    const child = createAgent({ provider: childModel, description: 'Helper' });
    const leadModel = mockModel([
      { toolCalls: [{ name: 'task', args: { agent: 'child', prompt: 'help me', description: 'help' } }] },
      'lead done',
    ]);
    const lead = createAgent({ provider: leadModel, subagents: { child }, guardrails: { input: [gate.guardrail] } });

    const stream = lead.stream('go');
    const run = record(stream);
    await until(() => gate.seen.length === 1);
    gate.pass(); // one deferred: the child's check passes at once too
    await run.done;

    expect((await stream.result).text).toBe('lead done');
    expect(gate.seen.map((ctx) => ctx.text)).toEqual(['go', 'help me']);
    const childText = run.events.filter((e) => e.type === 'text.delta' && e.subagent).map((e) => (e as { text: string }).text);
    expect(childText.join('')).toBe('child answer');
  });

  it('a trip inside a sub-agent cancels its call and nothing of it streams', async () => {
    const childText = 'child secret';
    const trips: IoGuardrail = {
      name: 'no-forbidden',
      runInParallel: true,
      check: async ({ text }) => {
        await tick();
        return text.includes('forbidden') ? { ok: false, reason: 'forbidden' } : { ok: true };
      },
    };
    const childModel = mockModel([waitingTurn(new Promise(() => undefined), childText)]);
    const child = createAgent({ provider: childModel, description: 'Helper' });
    const leadModel = mockModel([
      { toolCalls: [{ name: 'task', args: { agent: 'child', prompt: 'forbidden task', description: 'help' } }] },
      'lead done',
    ]);
    const lead = createAgent({ provider: leadModel, subagents: { child }, guardrails: { input: [trips] } });

    const stream = lead.stream('go');
    const run = record(stream);
    await run.done;

    expect((childModel.calls[0].signal as AbortSignal).aborted).toBe(true);
    const childDeltas = run.events.filter((e) => e.type === 'text.delta' && e.subagent);
    expect(childDeltas).toEqual([]);
    expect(run.events.find((e) => e.type === 'guardrail.tripped')).toMatchObject({ name: 'no-forbidden', subagent: { name: 'child' } });
    expect(JSON.stringify(leadModel.calls[1].messages)).not.toContain(childText);
    expect((await stream.result).text).toBe('lead done');
  });
});

describe('runInParallel on the starter set (N5b)', () => {
  it('promptInjectionGuardrail and moderationGuardrail take runInParallel (default off)', () => {
    const model = mockModel(['NONE']);
    expect(moderationGuardrail({ model }).runInParallel).toBeUndefined();
    expect(moderationGuardrail({ model, runInParallel: true }).runInParallel).toBe(true);
    expect(promptInjectionGuardrail({ model }).runInParallel).toBeUndefined();
    expect(promptInjectionGuardrail({ model, runInParallel: true }).runInParallel).toBe(true);
  });

  it('a parallel moderation trip cancels the agent call', async () => {
    const judge = mockModel(['violence']);
    const model = mockModel([waitingTurn(new Promise(() => undefined), 'leaked')]);
    const agent = createAgent({ provider: model, guardrails: { input: [moderationGuardrail({ model: judge, runInParallel: true })] } });

    const result = await agent.send('something violent');

    expect(result).toMatchObject({ finishReason: 'guardrail', guardrail: { name: 'moderation', info: { category: 'moderation', categories: ['violence'] } } });
    expect((model.calls[0].signal as AbortSignal).aborted).toBe(true);
  });
});
