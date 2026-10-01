/**
 * LOU-D44: AgentExecutor.fork() / agent.fork() start a new session from a
 * step of another session's checkpoint history, optionally patched, and the
 * fork resumes like any unfinished run while the original stays as it was.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AgentExecutor } from './AgentExecutor';
import type { Checkpoint, CheckpointStore } from './checkpoint';
import { ConfigurationError, SDKError } from './errors';
import { memoryStore } from '../storage/agentStore';
import { createAgent } from '../createAgent';
import { compareTrajectories } from '../evals/drift';
import { defineTool, type DefinedTool } from '../tools/defineTool';import { ToolRegistry } from '../tools';
import { mockModel, type MockTurn } from '../testing';
import type { AgentConfig } from '../types';

function tools(runs: Record<string, number>): DefinedTool[] {
  const counted = (name: string, result: unknown) => {
    runs[name] = 0;
    return defineTool({
      name,
      description: name,
      input: z.object({}),
      execute: async () => {
        runs[name]++;
        return result;
      },
    });
  };
  return [counted('weather', { forecast: 'sunny' }), counted('plan_picnic', 'picnic planned'), counted('buy_umbrella', 'umbrella bought')];
}

// Step 1 asks for the weather; step 2 acts on the forecast; step 3 reports the last tool result.
const askWeather: MockTurn = { toolCalls: [{ name: 'weather', id: 'call_weather' }] };
const decide: MockTurn = (req) => {
  const forecast = req.messages.find((m) => m.toolCallId === 'call_weather')?.content ?? '';
  const name = forecast.includes('rain') ? 'buy_umbrella' : 'plan_picnic';
  return { toolCalls: [{ name, id: `call_${name}` }] };
};
const report: MockTurn = (req) => `done: ${req.messages.at(-1)?.content}`;

function setup() {
  const runs: Record<string, number> = {};
  const defined = tools(runs);
  const registry = new ToolRegistry();
  registry.registerMany(defined);
  const agent: AgentConfig = {
    id: 'agent-1',
    name: 'Planner',
    prompt: 'Plan the trip.',
    tools: Object.fromEntries(defined.map((t) => [t.name, { tool: t.name }])),
  };
  const checkpointStore = memoryStore().checkpoints;
  const execute = (script: MockTurn[], sessionId: string, input: string | [] = []) => {
    const provider = mockModel(script);
    return { provider, result: AgentExecutor.execute({ agent, provider, toolRegistry: registry, input, sessionId, checkpointStore }) };
  };
  return { runs, agent, registry, checkpointStore, execute };
}

async function runOriginal(env: ReturnType<typeof setup>) {
  const original = await env.execute([askWeather, decide, report], 'trip', 'Plan my trip').result;
  expect(original.steps).toBe(3);
  expect(original.text).toBe('done: "picnic planned"');
  const store = env.checkpointStore;
  return { checkpoint: await store.load('trip'), history: await store.history?.('trip') };
}

describe('AgentExecutor.fork (LOU-D44)', () => {
  it('forks at step 1 with a patched tool result, resumes into a different trajectory and leaves the original untouched', async () => {
    const env = setup();
    const before = await runOriginal(env);

    const fork = await AgentExecutor.fork({
      sessionId: 'trip',
      fromStep: 1,
      checkpointStore: env.checkpointStore,
      patch: { toolResult: { toolCallId: 'call_weather', result: { forecast: 'rain' } } },
    });
    expect(fork.sessionId).toBe('trip.fork-1');
    expect(fork.step).toBe(1);
    expect(fork.checkpoint).toMatchObject({ sessionId: 'trip.fork-1', stepIndex: 1, status: 'in-progress' });
    // The result keeps its place, call id and tool name: the transcript stays provider-valid.
    expect(fork.checkpoint.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(fork.checkpoint.messages[3]).toMatchObject({ toolCallId: 'call_weather', toolName: 'weather', content: '{"forecast":"rain"}' });
    expect(await env.checkpointStore.load('trip.fork-1')).toEqual(fork.checkpoint);

    const { provider, result } = env.execute([decide, report], fork.sessionId);
    const replayed = await result;
    provider.assertExhausted();
    expect(replayed.text).toBe('done: "umbrella bought"');
    expect(replayed.steps).toBe(3);
    // Step 1 is not replayed: the weather tool ran once, in the original.
    expect(env.runs).toEqual({ weather: 1, plan_picnic: 1, buy_umbrella: 1 });

    expect(await env.checkpointStore.load('trip')).toEqual(before.checkpoint);
    expect(await env.checkpointStore.history?.('trip')).toEqual(before.history);

    const forked = await env.checkpointStore.load(fork.sessionId);
    const diff = compareTrajectories(before.checkpoint as Checkpoint, forked as Checkpoint);
    expect(diff.divergedAt).toBe(1);
    expect(diff.a[0].tools[0]).toMatchObject({ name: 'weather', result: '{"forecast":"sunny"}' });
    expect(diff.b[0].tools[0]).toMatchObject({ name: 'weather', result: '{"forecast":"rain"}' });
    expect(diff.drift).toContainEqual({ field: 'tools', committed: 'weather > plan_picnic', current: 'weather > buy_umbrella' });

    // A second fork gets the next id.
    const again = await AgentExecutor.fork({ sessionId: 'trip', fromStep: 2, checkpointStore: env.checkpointStore });
    expect(again.sessionId).toBe('trip.fork-2');
    // Unpatched, it matches the original up to the step it was forked at.
    const prefix = compareTrajectories(before.checkpoint as Checkpoint, again.checkpoint);
    expect(prefix.divergedAt).toBe(3);
    expect(prefix.b).toEqual(prefix.a.slice(0, 2));
    expect(prefix.drift).toContainEqual({ field: 'steps', committed: '3', current: '2' });
  });

  it('appendInput queues a user message the resumed fork sends; messages and businessState patches apply', async () => {
    const env = setup();
    await runOriginal(env);

    const fork = await AgentExecutor.fork({
      sessionId: 'trip',
      fromStep: 1,
      newSessionId: 'what-if',
      checkpointStore: env.checkpointStore,
      patch: {
        messages: (messages) => messages.map((m) => (m.role === 'user' ? { ...m, content: 'Plan a beach day' } : m)),
        businessState: { variant: 'b' },
        appendInput: 'It will rain, plan for that.',
      },
    });
    expect(fork.sessionId).toBe('what-if');
    expect(fork.checkpoint.businessState).toEqual({ variant: 'b' });
    expect(fork.checkpoint.messages.at(-1)).toEqual({ role: 'user', content: 'It will rain, plan for that.' });

    const rainy: MockTurn = (req) => {
      expect(req.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
      expect(req.messages[1].content).toBe('Plan a beach day');
      return { toolCalls: [{ name: 'buy_umbrella', id: 'call_umbrella' }] };
    };
    const { result } = env.execute([rainy, report], 'what-if');
    expect((await result).text).toBe('done: "umbrella bought"');
  });

  it('records a result for a call that has none yet, and queues appendInput behind it', async () => {
    const env = setup();
    await runOriginal(env);
    // The oldest step-1 entry is the one saved right after the model asked for the weather.
    const history = (await env.checkpointStore.history?.('trip')) ?? [];
    const pending = history.filter((e) => e.step === 1).at(-1)?.checkpoint as Checkpoint;
    const store = memoryStore().checkpoints;
    await store.save('pending', pending);

    const fork = await AgentExecutor.fork({
      sessionId: 'pending',
      fromStep: 1,
      checkpointStore: store,
      patch: { appendInput: 'Hurry.', toolResult: { toolCallId: 'call_weather', result: { forecast: 'rain' } } },
    });
    expect(fork.checkpoint.messages.slice(-2).map((m) => m.role)).toEqual(['tool', 'user']);
    const replayed = await AgentExecutor.execute({
      agent: env.agent,
      provider: mockModel([decide, report]),
      toolRegistry: env.registry,
      input: [],
      sessionId: fork.sessionId,
      checkpointStore: store,
    });
    expect(replayed.text).toBe('done: "umbrella bought"');
    expect(env.runs.weather).toBe(1); // the recorded result is used, the tool does not run again
  });

  it('rejects a missing step, an unknown session, a store without history and a taken session id', async () => {
    const env = setup();
    await runOriginal(env);
    const fork = (options: { sessionId?: string; fromStep?: number; newSessionId?: string; checkpointStore?: CheckpointStore }) =>
      AgentExecutor.fork({ sessionId: 'trip', fromStep: 1, checkpointStore: env.checkpointStore, ...options });

    const missing = await fork({ fromStep: 9 }).catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(SDKError);
    expect(missing).toMatchObject({ code: 'LOUSHY_CHECKPOINT_NOT_FOUND' });
    expect((missing as SDKError).detail).toContain('steps kept: 1, 2, 3');
    await expect(fork({ sessionId: 'nope' })).rejects.toMatchObject({ code: 'LOUSHY_CHECKPOINT_NOT_FOUND' });

    const store = env.checkpointStore;
    const noHistory: CheckpointStore = {
      save: (id, checkpoint) => store.save(id, checkpoint),
      load: (id) => store.load(id),
      delete: (id) => store.delete(id),
    };
    await expect(fork({ checkpointStore: noHistory })).rejects.toBeInstanceOf(ConfigurationError);
    await expect(fork({ newSessionId: 'trip' })).rejects.toBeInstanceOf(ConfigurationError);
    await expect(fork({})).resolves.toMatchObject({ sessionId: 'trip.fork-1' });
    await expect(fork({ newSessionId: 'trip.fork-1' })).rejects.toThrow(/already has a checkpoint/);
    await expect(
      AgentExecutor.fork({ sessionId: 'trip', fromStep: 1, checkpointStore: env.checkpointStore, patch: { toolResult: { toolCallId: 'x', result: 1 } } })
    ).rejects.toThrow(/no tool call 'x'/);
  });
});

describe('agent.fork (LOU-D44)', () => {
  it('forks a send() run in the agent store; agent.resume() continues the fork', async () => {
    const runs: Record<string, number> = {};
    const store = memoryStore();
    const provider = mockModel([askWeather, decide, report, decide, report]);
    const agent = createAgent({ provider, instructions: 'Plan the trip.', tools: tools(runs), store });

    expect((await agent.send('Plan my trip', { sessionId: 'trip' })).text).toBe('done: "picnic planned"');
    const fork = await agent.fork('trip', { fromStep: 1, patch: { toolResult: { toolCallId: 'call_weather', result: { forecast: 'rain' } } } });
    expect(fork.sessionId).toBe('trip.fork-1');

    const replayed = await agent.resume(fork.sessionId);
    expect(replayed?.text).toBe('done: "umbrella bought"');
    provider.assertExhausted();
    expect((await store.checkpoints.load('trip'))?.messages.at(-1)?.content).toBe('done: "picnic planned"');
  });

  it('needs a checkpoint store', async () => {
    const agent = createAgent({ provider: mockModel([]) });
    await expect(agent.fork('trip', { fromStep: 1 })).rejects.toMatchObject({ code: 'LOUSHY_CONFIG_MISSING_CHECKPOINT_STORE' });
  });
});
